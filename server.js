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
app.use(express.urlencoded({ extended: true }));

const tempTradieData = new Map();
const callSidToPhone = new Map();
const callSidToCaller = new Map();

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

function validateApiKeyAuth(req) {
  const apiKey = req.headers['x-api-key'];
  const timestamp = req.headers['x-timestamp'];
  const signature = req.headers['x-signature'];

  if (!apiKey || !timestamp || !signature) {
    return { valid: false, error: 'Missing required authentication headers' };
  }

  const now = Date.now();
  const requestTime = parseInt(timestamp);
  if (Math.abs(now - requestTime) > 5 * 60 * 1000) {
    return { valid: false, error: 'Timestamp expired or too far in future' };
  }

  const expectedSignature = crypto
    .createHmac('sha256', process.env.API_SHARED_SECRET)
    .update(`${apiKey}:${timestamp}`)
    .digest('hex');

  if (signature !== expectedSignature) {
    return { valid: false, error: 'Invalid signature' };
  }

  return { valid: true };
}

async function getTradieData(phoneNumber) {
  try {
    const headers = generateAuthHeaders();
    const response = await fetch(`${process.env.BOTIE_API_BASE_URL}/getuserbyassignednumber`, {
      method: 'GET',
      headers: { ...headers, 'assigned-number': phoneNumber }
    });
    if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
    return await response.json();
  } catch (err) {
    console.error('Error fetching tradie data:', err);
    return null;
  }
}

async function sendTaskToAPI(taskData, phoneNumber) {
  try {
    const headers = generateAuthHeaders();
    headers['assigned-number'] = phoneNumber;
    const response = await fetch(`${process.env.BOTIE_API_BASE_URL}/create-task-for-user`, {
      method: 'POST',
      headers,
      body: JSON.stringify(taskData)
    });
    if (!response.ok) throw new Error(`HTTP error: ${response.status}`);
    return await response.json();
  } catch (err) {
    console.error('Error sending task:', err);
    return null;
  }
}

function forceInvokeDeepgram(callSid, phoneNumber, callerPhoneNumber, callback) {
  const connection = dg.agent();
  let isConnected = false;

  connection.on(AgentEvents.Welcome, () => {
    isConnected = true;
    const connectionData = {
      connection,
      callSid,
      phoneNumber,
      callerPhoneNumber,
      isReady: true,
      audioBuffer: Buffer.alloc(0),
      conversationHistory: [],
      keepAliveInterval: setInterval(() => connection.keepAlive(), 5000),
      wsReady: false,
      audioChunks: [],
      ws: null,
      streamSid: null
    };

    connection.on(AgentEvents.Audio, (chunk) => {
      if (connectionData.wsReady && connectionData.ws && connectionData.ws.readyState === connectionData.ws.OPEN) {
        connectionData.ws.send(JSON.stringify({
          event: 'media',
          streamSid: connectionData.streamSid,
          media: { payload: Buffer.from(chunk).toString('base64') }
        }));
      } else {
        connectionData.audioChunks.push(chunk);
      }
    });

    connection.on(AgentEvents.ConversationText, (data) => {
      console.log('[🎤 Deepgram Response Received]:', JSON.stringify(data, null, 2));
      connectionData.conversationHistory.push({
        role: data.role,
        content: data.content,
        timestamp: new Date().toISOString()
      });
      if (data.role === 'assistant' && data.content === 'BYE') cleanupConnection(connectionData);
    });

    connection.on(AgentEvents.Error, err => console.error('Deepgram Error:', err));

    tempTradieData.set(callSid, connectionData);
    callback(connectionData, null);
  });

  connection.on(AgentEvents.Error, err => {
    if (!isConnected) callback(null, err.message);
  });
}

function cleanupConnection(connectionData) {
  if (!connectionData) return;
  clearInterval(connectionData.keepAliveInterval);
  try { connectionData.connection.disconnect(); } catch (err) {}
  if (connectionData.conversationHistory.length > 0) processConversationData(connectionData);
  tempTradieData.delete(connectionData.callSid);
  callSidToPhone.delete(connectionData.callSid);
  callSidToCaller.delete(connectionData.callSid);
}

function processConversationData(connectionData) {
  const conversationText = connectionData.conversationHistory.map(e => `${e.role}: ${e.content}`).join('\n');
  const prompt = `Based on this conversation, create a JSON payload for a task:\n${conversationText}`;

  fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-4.1-nano',
      messages: [
        { role: 'system', content: 'You are a helpful assistant. Return only valid JSON.' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 500
    })
  })
    .then(res => res.json())
    .then(result => {
      const match = result.choices[0].message.content.match(/\{[\s\S]*\}/);
      if (!match) throw new Error('No JSON found');
      const taskData = JSON.parse(match[0]);
      sendTaskToAPI(taskData, connectionData.phoneNumber);
    })
    .catch(err => console.error('Conversation processing error:', err));
}

wss.on('connection', (wsTwilio, req) => {
  let streamSid = null, callSid = null, connectionData = null;

  wsTwilio.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.event === 'start') {
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        connectionData = tempTradieData.get(callSid);
        if (connectionData) {
          connectionData.ws = wsTwilio;
          connectionData.streamSid = streamSid;
          connectionData.wsReady = true;
          if (connectionData.audioBuffer.length > 0) {
            connectionData.connection.send(connectionData.audioBuffer);
            connectionData.audioBuffer = Buffer.alloc(0);
          }
          connectionData.audioChunks.forEach(chunk => {
            wsTwilio.send(JSON.stringify({
              event: 'media',
              streamSid,
              media: { payload: Buffer.from(chunk).toString('base64') }
            }));
          });
          connectionData.audioChunks = [];
        }
      } else if (msg.event === 'media' && connectionData?.connection) {
        connectionData.connection.send(Buffer.from(msg.media.payload, 'base64'));
      }
    } catch (err) {
      console.error('WS error:', err);
    }
  });

  wsTwilio.on('close', () => {
    if (connectionData) cleanupConnection(connectionData);
  });
});

server.on('upgrade', (req, socket, head) => {
  if (req.url === '/twilio') {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

app.post('/twiml', (req, res) => {
  const phoneNumber = decodeURIComponent(req.body.To || req.body.Called || '');
  const callSid = req.body.CallSid;
  const callerPhoneNumber = decodeURIComponent(req.body.From || '');

  callSidToPhone.set(callSid, phoneNumber);
  callSidToCaller.set(callSid, callerPhoneNumber);

  forceInvokeDeepgram(callSid, phoneNumber, callerPhoneNumber, () => {});

  res.type('text/xml').send(`
    <Response>
      <Say language="en-AU">You've reached Botie. I can take your job request, please wait a moment, our representative will be with you shortly</Say>
      <Connect><Stream url="wss://${req.headers.host}/twilio" /></Connect>
      <Say language="en-AU">Your job has been recorded by the CSR. Goodbye</Say>
    </Response>
  `);
});

app.get('/test-api-auth', (req, res) => {
  const validation = validateApiKeyAuth(req);
  if (!validation.valid) return res.status(401).json({ success: false, error: validation.error });
  res.json({ success: true, message: 'API key authentication successful' });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
