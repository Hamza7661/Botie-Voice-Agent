// deepgram-botie-server.js
import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createClient, AgentEvents } from '@deepgram/sdk';
import dotenv from 'dotenv';
import crypto from 'crypto';
import fetch from 'node-fetch';

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const dg = createClient(process.env.DEEPGRAM_API_KEY);

app.use(express.json());

const activeCalls = new Map();

function generateAuthHeaders() {
  const timestamp = Date.now().toString();
  const apiKey = crypto.randomBytes(32).toString('hex');
  const signature = crypto
    .createHmac('sha256', process.env.API_SHARED_SECRET)
    .update(`${apiKey}:${timestamp}`)
    .digest('hex');
  return {
    'x-api-key': apiKey,
    'x-timestamp': timestamp,
    'x-signature': signature,
    'Content-Type': 'application/json'
  };
}

async function getTradieData(phoneNumber) {
  try {
    const headers = generateAuthHeaders();
    headers['assigned-number'] = phoneNumber;
    const res = await fetch(`${process.env.BOTIE_API_BASE_URL}/getuserbyassignednumber`, { headers });
    return res.ok ? await res.json() : null;
  } catch (err) {
    console.error('❌ Tradie API Error:', err);
    return null;
  }
}

async function createTask(taskData, phoneNumber) {
  try {
    const headers = generateAuthHeaders();
    headers['assigned-number'] = phoneNumber;
    const res = await fetch(`${process.env.BOTIE_API_BASE_URL}/create-task-for-user`, {
      method: 'POST',
      headers,
      body: JSON.stringify(taskData)
    });
    return res.ok ? await res.json() : null;
  } catch (err) {
    console.error('❌ Task API Error:', err);
    return null;
  }
}

async function summarizeConversation(convo, callerPhoneNumber) {
  const text = convo.map(m => `${m.role}: ${m.content}`).join('\n');
  const prompt = `Based on this conversation, return JSON with heading, summary, description, full conversation, and customer { name, address, phoneNumber: "${callerPhoneNumber}" }, isResolved=false.\n\n${text}`;

  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4.1-nano',
      messages: [
        { role: 'system', content: 'Return only JSON. No explanation.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 500
    })
  });

  const result = await res.json();
  const match = result.choices[0].message.content.match(/\{[\s\S]*\}/);
  return match ? JSON.parse(match[0]) : null;
}

function createDeepgramAgent(callSid, phoneNumber, callerPhoneNumber) {
  const agent = dg.agent();
  const conversation = [];

  agent.on(AgentEvents.Welcome, () => {
    agent.configure({
      audio: {
        input: { encoding: 'mulaw', sample_rate: 8000 },
        output: { encoding: 'mulaw', sample_rate: 8000 }
      },
      agent: {
        language: 'en',
        greeting: 'Hi. How can I help you today?',
        listen: { provider: { type: 'deepgram', model: 'nova-3' } },
        think: {
          provider: { type: 'open_ai', model: 'gpt-4.1-nano' },
          prompt: 'You are a helpful agent. Ask the customer name, address, and issue. When done, say BYE.'
        },
        speak: { provider: { type: 'deepgram', model: 'aura-2-thalia-en' } }
      }
    });
  });

  agent.on(AgentEvents.Audio, chunk => {
    const ws = activeCalls.get(callSid)?.ws;
    const streamSid = activeCalls.get(callSid)?.streamSid;
    if (ws && ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify({
        event: 'media',
        streamSid,
        media: { payload: Buffer.from(chunk).toString('base64') }
      }));
    }
  });

  agent.on(AgentEvents.ConversationText, async data => {
    conversation.push(data);
    if (data.role === 'assistant' && data.content === 'BYE') {
      const tradie = await getTradieData(phoneNumber);
      const task = await summarizeConversation(conversation, callerPhoneNumber);
      if (tradie && task) await createTask(task, phoneNumber);
      agent.disconnect();
      activeCalls.get(callSid)?.ws.close();
      activeCalls.delete(callSid);
    }
  });

  agent.on(AgentEvents.Error, err => console.error(`[Deepgram Error ${callSid}]`, err));
  return agent;
}

wss.on('connection', (ws, req) => {
  let callSid = null;

  ws.on('message', async msg => {
    const data = JSON.parse(msg);

    if (data.event === 'start') {
      callSid = data.start.callSid;
      const phoneNumber = decodeURIComponent(data.start.to || '');
      const caller = decodeURIComponent(data.start.from || '');
      const agent = createDeepgramAgent(callSid, phoneNumber, caller);
      activeCalls.set(callSid, { ws, streamSid: data.start.streamSid, agent });

    } else if (data.event === 'media' && callSid) {
      activeCalls.get(callSid)?.agent.send(Buffer.from(data.media.payload, 'base64'));
    }
  });

  ws.on('close', () => {
    if (callSid) {
      activeCalls.get(callSid)?.agent.disconnect();
      activeCalls.delete(callSid);
    }
  });
});

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/twilio') {
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

app.post('/twiml', (req, res) => {
  const host = req.headers.host;
  res.type('text/xml').send(`
    <Response>
      <Say language="en-AU">Welcome to Botie. Please wait while we connect you.</Say>
      <Connect>
        <Stream url="wss://${host}/twilio" />
      </Connect>
    </Response>
  `);
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`✅ Botie Deepgram server ready on port ${PORT}`));
