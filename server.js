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

// Middleware to parse JSON and URL-encoded bodies
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store tradie data and phone number temporarily for WebSocket connections
const tempTradieData = new Map();
const callSidToPhone = new Map();
const callSidToCaller = new Map();

// Utility function to generate API key authentication headers
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

// Utility function to validate API key authentication
function validateApiKeyAuth(req) {
  const apiKey = req.headers['x-api-key'];
  const timestamp = req.headers['x-timestamp'];
  const signature = req.headers['x-signature'];

  if (!apiKey || !timestamp || !signature) {
    return { valid: false, error: 'Missing required authentication headers' };
  }

  // Check if timestamp is within 5 minutes (prevent replay attacks)
  const now = Date.now();
  const requestTime = parseInt(timestamp);
  if (Math.abs(now - requestTime) > 5 * 60 * 1000) {
    return { valid: false, error: 'Timestamp expired or too far in future' };
  }

  // Verify signature
  const expectedSignature = crypto
    .createHmac('sha256', process.env.API_SHARED_SECRET)
    .update(`${apiKey}:${timestamp}`)
    .digest('hex');

  if (signature !== expectedSignature) {
    return { valid: false, error: 'Invalid signature' };
  }

  return { valid: true };
}

// Utility function to fetch tradie data from third-party API
async function getTradieData(phoneNumber) {
  try {
    console.log(`[🔍 Fetching tradie data for phone number: ${phoneNumber}]`);
    
    const headers = generateAuthHeaders();
    const response = await fetch(`${process.env.BOTIE_API_BASE_URL}/getuserbyassignednumber`, {
      method: 'GET',
      headers: {
        ...headers,
        'assigned-number': phoneNumber
      }
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const tradieData = await response.json();
    console.log(`[✅ Tradie data fetched successfully]`, tradieData);
    return tradieData;
  } catch (error) {
    console.error(`[❌ Error fetching tradie data for phone number ${phoneNumber}:]`, error);
    return null;
  }
}

// Function to send task data to API
async function sendTaskToAPI(taskData, phoneNumber) {
  try {
    console.log(`[📤 Sending task data to API:`, taskData);
    
    const headers = generateAuthHeaders();
    headers['Content-Type'] = 'application/json';
    headers['assigned-number'] = phoneNumber;
    
    const response = await fetch(`${process.env.BOTIE_API_BASE_URL}/create-task-for-user`, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(taskData)
    });

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const result = await response.json();
    console.log(`[✅ Task created successfully]`, result);
    return result;
  } catch (error) {
    console.error(`[❌ Error sending task data:]`, error);
    return null;
  }
}

wss.on('connection', async (wsTwilio, req) => {
  console.log('[🔗 Twilio WS Connected]');
  let audioBuffer = Buffer.alloc(0);
  let keepAliveInterval;
  let streamSid = null;
  let isAgentReady = false;
  let tradieData = null;
  let conversationHistory = [];
  let callSid = null;
  let callerPhoneNumber = null;
  
  let connection = dg.agent();

  connection.on(AgentEvents.Welcome, () => {
    console.log('✅ Deepgram Agent Connected');
    
    // Use default configuration initially, will be updated when tradie data is available
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
    console.log('✅ Setting agent as ready after Welcome event');
    isAgentReady = true;
    
    // Send any buffered audio
    if (audioBuffer.length > 0) {
      console.log(`[📤 Sending ${audioBuffer.length} bytes of buffered audio]`);
      connection.send(audioBuffer);
      audioBuffer = Buffer.alloc(0);
    }
    
    console.log(`[🎯 Agent ready to receive audio at ${new Date().toISOString()}]`);
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

  connection.on(AgentEvents.ConversationText, async (data) => {
    console.log('[🗣️ Transcription]', JSON.stringify(data, null, 2));
    
    // Track conversation history
    conversationHistory.push({
      role: data.role,
      content: data.content,
      timestamp: new Date().toISOString()
    });
    
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
        if (isAgentReady) {
          connection.send(Buffer.from(msg.media.payload, 'base64'));
        } else {
          // If agent not ready, buffer the audio
          audioBuffer = Buffer.concat([audioBuffer, Buffer.from(msg.media.payload, 'base64')]);
        }
      } else if (msg.event === 'start') {
        console.log('[🔈 Twilio Media Start]', msg.start);
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        
        // Retrieve tradie data and caller phone number using Call SID to ensure we get the correct data for this call
        if (callSid && tempTradieData.has(callSid)) {
          tradieData = tempTradieData.get(callSid);
          const phoneNumber = callSidToPhone.get(callSid);
          callerPhoneNumber = callSidToCaller.get(callSid);
          console.log(`[✅ Retrieved tradie data for call ${callSid}, phone: ${phoneNumber}, caller: ${callerPhoneNumber}]`);
        } else {
          console.log(`[⚠️ No tradie data found for call SID: ${callSid}]`);
        }
      }
    } catch (err) {
      console.error('[⚠️ WS Parse Error]', err);
    }
  });

  wsTwilio.on('close', async () => {
    console.log('[🔌 Twilio WS Disconnected]');

    // Create task if we have conversation data and tradie data
    if (conversationHistory.length > 0 && tradieData) {
      console.log('[📋 Processing conversation data for task creation]');
      
      try {
        // Create a conversation summary for AI analysis
        const conversationText = conversationHistory
          .map(entry => `${entry.role}: ${entry.content}`)
          .join('\n');
        
        // Simple prompt to ChatGPT
        const aiPrompt = `Based on this conversation, create a JSON payload for a task:

Conversation:
${conversationText}

Create a JSON with:
- heading: Professional job title
- summary: Brief job description  
- description: Description of the task/issue (not the full conversation)
- conversation: The complete conversation as a string
- customer: { name, address, phoneNumber: "${callerPhoneNumber || ''}" }
- isResolved: false

Return only the JSON.`;

        // Call ChatGPT API
        const response = await fetch('https://api.openai.com/v1/chat/completions', {
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
        });

        if (!response.ok) {
          throw new Error(`ChatGPT API failed: ${response.status}`);
        }

        const result = await response.json();
        const aiResponse = result.choices[0].message.content;
        
        // Extract JSON from AI response
        const jsonMatch = aiResponse.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
          throw new Error('No JSON found in AI response');
        }
        
        const taskData = JSON.parse(jsonMatch[0]);
        console.log('[📤 Task data extracted:', taskData, ']');
        
        // Send task to API using the tradie's phone number
        const tradiePhoneNumber = tradieData?.data?.twilioPhoneNumber || tradieData?.twilioPhoneNumber;
        if (tradiePhoneNumber) {
          sendTaskToAPI(taskData, tradiePhoneNumber).then(result => {
            if (result) {
              console.log('[✅ Task created successfully in API]');
            } else {
              console.log('[❌ Failed to create task in API]');
            }
          });
        } else {
          console.log('[❌ No tradie phone number available for task creation]');
        }
      } catch (error) {
        console.error('[❌ Error extracting conversation data:', error, ']');
      }
    } else {
      console.log('[❌ No conversation history or tradie data available for task creation]');
      console.log('[📋 Conversation history length:', conversationHistory.length, ']');
      console.log('[📋 Tradie data available:', !!tradieData, ']');
    }

    // Clean up tradie data for this specific call
    if (callSid) {
      tempTradieData.delete(callSid);
      callSidToPhone.delete(callSid);
      callSidToCaller.delete(callSid);
      console.log(`[🧹 Cleaned up tradie data for call ${callSid}]`);
    }

    if (keepAliveInterval) {
      clearInterval(keepAliveInterval);
      keepAliveInterval = null;
    }
    
    if (connection) {
      try {
        connection.disconnect();
      } catch (err) {
        console.error('[⚠️ Error closing Deepgram connection]', err);
      }
    }
  });
});

server.on('upgrade', (req, socket, head) => {
  console.log('[UPGRADE]', req.url);
  if (req.url.startsWith('/twilio')) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      console.log('[✅ WebSocket upgraded]');
      wss.emit('connection', ws, req);
    });
  } else {
    socket.destroy();
  }
});

app.post('/twiml', async (req, res) => {
  try {
    // Extract the phone number and Call SID from Twilio request
    const phoneNumber = decodeURIComponent(req.body.To || req.body.Called || '');
    const callSid = req.body.CallSid;
    const callerPhoneNumber = decodeURIComponent(req.body.From || '');
    
    console.log(`[📱 Phone number being called: ${phoneNumber}]`);
    console.log(`[📞 Call SID: ${callSid}]`);
    console.log(`[📞 Caller phone number: ${callerPhoneNumber}]`);
    
    // Fetch tradie data when call starts
    let tradieData = null;
    if (phoneNumber) {
      console.log(`[🔍 Fetching tradie data for phone number: ${phoneNumber}]`);
      tradieData = await getTradieData(phoneNumber);
      if (tradieData) {
        console.log(`[✅ Tradie data fetched successfully for ${phoneNumber}]`);
        // Store tradie data with Call SID as key to avoid interference between calls
        tempTradieData.set(callSid, tradieData);
        callSidToPhone.set(callSid, phoneNumber);
        callSidToCaller.set(callSid, callerPhoneNumber);
      } else {
        console.log(`[❌ No tradie data found for phone number: ${phoneNumber}]`);
      }
    }
    
    // Create personalized greeting (will be customized in WebSocket connection)
    const greeting = `You've reached our service. I can take your job request, please wait a moment, our representative will be with you shortly`;
    const goodbye = `Your job has been recorded by the CSR. Goodbye`;

    res.type('text/xml').send(`
      <Response>
        <Say language="en-AU">${greeting}</Say>
        <Connect>
          <Stream url="wss://${req.headers.host}/twilio" />
        </Connect>
        <Say language="en-AU">${goodbye}</Say>
      </Response>
    `);
  } catch (error) {
    console.error('[❌ Error in TwiML endpoint:]', error);
    // Fallback response
    res.type('text/xml').send(`
      <Response>
        <Say language="en-AU">You've reached Botie, I can take your job request, please wait a moment, our representative will be with you shortly</Say>
        <Connect>
          <Stream url="wss://${req.headers.host}/twilio" />
        </Connect>
        <Say language="en-AU">Your job has been recorded by the CSR. Goodbye</Say>
      </Response>
    `);
  }
});

// Test endpoint for API key authentication
app.get('/test-api-auth', (req, res) => {
  const validation = validateApiKeyAuth(req);
  
  if (!validation.valid) {
    return res.status(401).json({
      success: false,
      error: validation.error
    });
  }

  res.json({
    success: true,
    message: 'API key authentication successful',
    data: {
      timestamp: new Date().toISOString(),
      apiKey: req.headers['x-api-key']
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
