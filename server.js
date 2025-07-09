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
app.use(express.urlencoded({ extended: true }));

const activeCalls = new Map();
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

async function getTradieData(phoneNumber) {
  try {
    const headers = generateAuthHeaders();
    headers['assigned-number'] = phoneNumber;
    const res = await fetch(`${process.env.BOTIE_API_BASE_URL}/getuserbyassignednumber`, { headers });
    const data = res.ok ? await res.json() : null;
    if (!data) {
      console.log('[⚠️ Task creation failed]', await res.text());
    }
    console.log(`[📞 Tradie data fetched for ${phoneNumber}]`);
    return data;
  } catch (err) {
    console.error('❌ Tradie API Error:', err);
    return null;
  }
}

async function createTask(taskData, phoneNumber) {
  try {
    const headers = generateAuthHeaders();
    headers['assigned-number'] = phoneNumber;
    const res = await fetch(`${process.env.BOTIE_API_BASE_URL}/create-task`, {
      method: 'POST',
      headers,
      body: JSON.stringify(taskData)
    });
    const data = res.ok ? await res.json() : null;
    console.log(`[✅ Task created for ${phoneNumber}]:`, data);
    return data;
  } catch (err) {
    console.error('❌ Task API Error:', err);
    return null;
  }
}

async function sendTaskToAPI(taskData, phoneNumber) {
  try {

    const headers = generateAuthHeaders();
    headers['Content-Type'] = 'application/json';
    headers['assigned-number'] = phoneNumber;

    const url = `${process.env.BOTIE_API_BASE_URL}/create-task-for-user`;
    const requestBody = JSON.stringify(taskData);
    const response = await fetch(url, {
      method: 'POST',
      headers: headers,
      body: requestBody
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.log(`[❌ Error Response Body:]`, errorText);
      throw new Error(`HTTP error! status: ${response.status}, body: ${errorText}`);
    }

    const result = await response.json();
    console.log(`[✅ Task created successfully]`);
    return result;
  } catch (error) {
    console.error(`[❌ Error sending task data]`, error);
    return null;
  }
}



async function summarizeConversation(convo, callerPhoneNumber, tradie) {

  const conversationText = convo
    .map(entry => `${entry.role}: ${entry.content}`)
    .join('\n');

  // Simple prompt to ChatGPT
  const aiPrompt = `Based on this conversation, judge if the user is setting a reminder or asking for an appointment or job request and create a JSON payload for a task:

  Conversation:
  ${conversationText}

  Create a JSON with:
  - heading: Professional job title
  - summary: Brief job description  
  - description: Description of the task/issue (not the full conversation)
  - reminder: Reminder text if the user is setting a reminder if not set it to null
  - reminderLocation: Location (lat, long) of the reminder if the user is setting a reminder and mentioned a location if not set it to null
  - reminderTime: Time of the reminder if the user is setting a reminder and mentioned a time if not set it to null
  - conversation: The complete conversation as a string
  - customer: { name, address, phoneNumber: "${callerPhoneNumber || ''}" }
  - isResolved: false

  Return only the JSON.`;

  // Call ChatGPT API
  fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: 'gpt-4.1-nano',
      messages: [
        {
          role: 'system',
          content: 'You are a helpful assistant that creates task JSON from conversations. Return only valid JSON.'
        },
        {
          role: 'user',
          content: aiPrompt
        }
      ],
      temperature: 0.3,
      max_tokens: 500
    })
  })
    .then(response => {
      if (!response.ok) {
        throw new Error(`ChatGPT API failed: ${response.status}`);
      }
      return response.json();
    })
    .then(result => {
      const aiResponse = result.choices[0].message.content;

      // Extract JSON from AI response
      const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error('No JSON found in AI response');
      }

      const taskData = JSON.parse(jsonMatch[0]);

      // Send task to API using the tradie's phone number
      const tradiePhoneNumber = tradie?.data?.twilioPhoneNumber;
      if (tradiePhoneNumber) {
        sendTaskToAPI(taskData, tradiePhoneNumber).then(result => {
          if (result) {
            console.log(`[✅ Task created successfully in API for call]`);
          } else {
            console.log(`[❌ Failed to create task in API for call]`);
          }
        });
      } else {
        console.log(`[❌ No tradie phone number available for task creation for call ${callerPhoneNumber}]`);
      }
    })
    .catch(error => {
      console.error(`[❌ Error extracting conversation data for call ${callerPhoneNumber}:`, error, ']');
    });
}

function createDeepgramAgent(callSid, phoneNumber, callerPhoneNumber, tradie) {
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
          prompt: `You are an AI assistant for booking appointments or setting reminders for the business: ${tradie?.data?.profession}, described as: ${tradie?.data?.professionDescription}.

Do not ask the user whether they are booking an appointment, making a job request, or setting a reminder. Instead, determine the intent based on what the user says.

If the user is making an appointment or job request:
- First, ask for the customer's name.
- Then, ask for the address.
- Then, ask about the issue or job details.
- Be natural, do not ask everything at once, and avoid overwhelming the user.

If the user is setting a reminder:
- Then ask for the reminder time, if provided or needed.
- Then ask for the reminder location, if applicable.
- Be quick and only collect this minimum required info and if in the first message user has given all the information then no need to ask anything else and set the reminder.

Once done:
- If it was a reminder, say: "Reminder is set."
- If it was an appointment or job request, say: "Thanks, we have got your job request. Someone will be with you shortly. Thank you for reaching out."

Always end with on a new line:
"Goodbye"
`
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
    if (data.role === 'assistant' && data.content == 'Goodbye') {
      const task = await summarizeConversation(conversation, callerPhoneNumber, tradie);
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
      const phoneNumber = callSidToPhone.get(callSid) || '';
      const caller = callSidToCaller.get(callSid) || decodeURIComponent(data.start.from || '');
      const tradie = await getTradieData(phoneNumber);
      const agent = createDeepgramAgent(callSid, phoneNumber, caller, tradie);
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
  const phoneNumber = decodeURIComponent(req.body.To || req.body.Called || '');
  const callSid = req.body.CallSid;
  const callerPhoneNumber = decodeURIComponent(req.body.From || '');
  callSidToPhone.set(callSid, phoneNumber);
  callSidToCaller.set(callSid, callerPhoneNumber);

  const host = req.headers.host;
  res.type('text/xml').send(`
    <Response>
      <Say language="en-AU">You've reached Botie, Please wait for a moment, a CSR will be with you shortly.</Say>
      <Connect>
        <Stream url="wss://${host}/twilio" />
      </Connect>
    </Response>
  `);
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`✅ Botie Deepgram server ready on port ${PORT}`));
