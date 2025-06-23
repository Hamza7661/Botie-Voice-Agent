import http from 'http';
import express from 'express';
import { WebSocketServer } from 'ws';
import { createClient, AgentEvents } from '@deepgram/sdk';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });
const dg = createClient(process.env.DEEPGRAM_API_KEY);

wss.on('connection', async (wsTwilio, req) => {
  console.log('[🔗 Twilio WS Connected]');
  let audioBuffer = Buffer.alloc(0);
  let keepAliveInterval;
  let streamSid = null;

  let connection = dg.agent();

  connection.on(AgentEvents.Welcome, () => {
    console.log('✅ Deepgram Agent Connected');
    connection.configure({
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
          prompt: `You are Botie, a friendly Australian CSR. Have conversation and collect name, address, and issue. Dont ask everything at once. Say "Thanks, we've got your job request. Someone will be in touch shortly. Goodbye! BYE" when done.`
        },
        speak: { provider: { type: 'deepgram', model: 'aura-2-thalia-en' } }
      }
    });
    keepAliveInterval = setInterval(() => connection.keepAlive(), 5000);
  });

  connection.on(AgentEvents.Audio, (chunk) => {
    if (streamSid) {
      wsTwilio.send(JSON.stringify({
        event: 'media',
        streamSid: streamSid,
        media: { payload: Buffer.from(chunk).toString('base64') }
      }));
    }
  });

  connection.on(AgentEvents.Error, (err) => {
    console.error('[Deepgram Error]', err);
  });

  connection.on(AgentEvents.ConversationText, (data) => {
    console.log('[🗣️ Transcription]', JSON.stringify(data, null, 2));
    if (data.role == "assistant" && data.content == "BYE") {

      console.log('[👋 Closing connection after goodbye]');

      if (wsTwilio && wsTwilio.readyState === wsTwilio.OPEN) {
        wsTwilio.close();
      }
    }
  });

  wsTwilio.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.event === 'media') {
        connection.send(Buffer.from(msg.media.payload, 'base64'));
      } else if (msg.event === 'start') {
        console.log('[🔈 Twilio Media Start]', msg.start);
        streamSid = msg.start.streamSid;
      }
    } catch (err) {
      console.error('[⚠️ WS Parse Error]', err);
    }
  });

  wsTwilio.on('close', () => {
    console.log('[🔌 Twilio WS Disconnected]');

    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }

    if (connection && connection.isConnected()) {
      console.log("Closing Deepgram")
      connection = null;
    }
  });
});

server.on('upgrade', (req, socket, head) => {
  console.log('[UPGRADE]', req.url);
  if (req.url === '/twilio') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log('[✅ WebSocket upgraded]');
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

app.post('/twiml', (req, res) => {
  res.type('text/xml').send(`
    <Response>
      <Say language="en-AU">You've reached Botie, I can take your job request, please wait a moment, our representative will be with you shortly</Say>
      <Connect>
        <Stream url="wss://${req.headers.host}/twilio" />
      </Connect>
      <Say language="en-AU">Your job has been recorded by the CSR. Goodbye</Say>
    </Response>
  `);
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
