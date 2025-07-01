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

// Function to force invoke Deepgram connection for new calls
function forceInvokeDeepgram(callSid, phoneNumber, callerPhoneNumber, callback) {
  console.log(`[🚀 Force invoking Deepgram for call ${callSid}]`);
  
  // Create new Deepgram connection
  const connection = dg.agent();
  let isConnected = false;
  
  connection.on(AgentEvents.Welcome, () => {
    console.log(`[✅ Deepgram Agent Connected for call ${callSid}]`);
    isConnected = true;
    
    // Configure agent with default settings
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
    
    // Store connection data for this call
    const connectionData = {
      connection: connection,
      callSid: callSid,
      phoneNumber: phoneNumber,
      callerPhoneNumber: callerPhoneNumber,
      isReady: true,
      audioBuffer: Buffer.alloc(0),
      conversationHistory: [],
      keepAliveInterval: null
    };
    
    // Start keep alive
    connectionData.keepAliveInterval = setInterval(() => {
      try {
        connection.keepAlive();
      } catch (err) {
        console.error('[⚠️ Keep alive error]', err);
      }
    }, 5000);
    
    // Set up event handlers
    connection.on(AgentEvents.Audio, (chunk) => {
      // Audio will be sent when WebSocket connects
      console.log(`[🔊 Deepgram audio received for call ${callSid}]`);
    });
    
    connection.on(AgentEvents.Error, (err) => {
      console.error(`[❌ Deepgram Error for call ${callSid}]`, err);
    });
    
    connection.on(AgentEvents.ConversationText, (data) => {
      console.log(`[🗣️ Transcription for call ${callSid}]`, JSON.stringify(data, null, 2));
      
      // Track conversation history
      connectionData.conversationHistory.push({
        role: data.role,
        content: data.content,
        timestamp: new Date().toISOString()
      });
      
      if (data.role == "assistant" && data.content == "BYE") {
        console.log(`[👋 Closing connection after goodbye for call ${callSid}]`);
        cleanupConnection(connectionData);
      }
    });
    
    // Store connection data globally
    tempTradieData.set(callSid, connectionData);
    
    callback(connectionData, null);
  });
  
  connection.on(AgentEvents.Error, (err) => {
    console.error(`[❌ Deepgram connection error for call ${callSid}]`, err);
    if (!isConnected) {
      callback(null, err.message || 'Connection failed');
    }
  });
}

// Function to cleanup connection
function cleanupConnection(connectionData) {
  if (!connectionData) return;
  
  console.log(`[🧹 Cleaning up connection for call ${connectionData.callSid}]`);
  
  if (connectionData.keepAliveInterval) {
    clearInterval(connectionData.keepAliveInterval);
  }
  
  if (connectionData.connection) {
    try {
      connectionData.connection.disconnect();
    } catch (err) {
      console.error('[⚠️ Error closing Deepgram connection]', err);
    }
  }
  
  // Process conversation data if available
  if (connectionData.conversationHistory.length > 0) {
    processConversationData(connectionData);
  }
  
  // Clean up from storage
  tempTradieData.delete(connectionData.callSid);
  callSidToPhone.delete(connectionData.callSid);
  callSidToCaller.delete(connectionData.callSid);
}

// Function to process conversation data
function processConversationData(connectionData) {
  console.log(`[📋 Processing conversation data for call ${connectionData.callSid}]`);
  
  try {
    // Create a conversation summary for AI analysis
    const conversationText = connectionData.conversationHistory
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
- customer: { name, address, phoneNumber: "${connectionData.callerPhoneNumber || ''}" }
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
      console.log(`[📤 Task data extracted for call ${connectionData.callSid}:`, taskData, ']');
      
      // Send task to API using the tradie's phone number
      const tradiePhoneNumber = connectionData.phoneNumber;
      if (tradiePhoneNumber) {
        sendTaskToAPI(taskData, tradiePhoneNumber).then(result => {
          if (result) {
            console.log(`[✅ Task created successfully in API for call ${connectionData.callSid}]`);
          } else {
            console.log(`[❌ Failed to create task in API for call ${connectionData.callSid}]`);
          }
        });
      } else {
        console.log(`[❌ No tradie phone number available for task creation for call ${connectionData.callSid}]`);
      }
    })
    .catch(error => {
      console.error(`[❌ Error extracting conversation data for call ${connectionData.callSid}:`, error, ']');
    });
  } catch (error) {
    console.error(`[❌ Error processing conversation data for call ${connectionData.callSid}:`, error, ']');
  }
}

wss.on('connection', (wsTwilio, req) => {
  console.log('[🔗 Twilio WS Connected]');
  let streamSid = null;
  let callSid = null;
  let connectionData = null;

  wsTwilio.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      if (msg.event === 'media') {
        // Get connection data for this call
        if (callSid && tempTradieData.has(callSid)) {
          connectionData = tempTradieData.get(callSid);
          if (connectionData && connectionData.isReady && connectionData.connection) {
            // Send audio to Deepgram
            connectionData.connection.send(Buffer.from(msg.media.payload, 'base64'));
          } else {
            // Buffer audio if connection not ready
            if (connectionData) {
              connectionData.audioBuffer = Buffer.concat([connectionData.audioBuffer, Buffer.from(msg.media.payload, 'base64')]);
            }
          }
        }
      } else if (msg.event === 'start') {
        console.log('[🔈 Twilio Media Start]', msg.start);
        streamSid = msg.start.streamSid;
        callSid = msg.start.callSid;
        
        // Get connection data for this call
        if (callSid && tempTradieData.has(callSid)) {
          connectionData = tempTradieData.get(callSid);
          console.log(`[✅ Retrieved connection data for call ${callSid}]`);
          
          // Send any buffered audio
          if (connectionData && connectionData.audioBuffer.length > 0 && connectionData.isReady) {
            console.log(`[📤 Sending ${connectionData.audioBuffer.length} bytes of buffered audio]`);
            connectionData.connection.send(connectionData.audioBuffer);
            connectionData.audioBuffer = Buffer.alloc(0);
          }
          
          // Set up audio output handler for this specific connection
          if (connectionData && connectionData.connection) {
            connectionData.connection.on(AgentEvents.Audio, (chunk) => {
              if (streamSid && wsTwilio.readyState === wsTwilio.OPEN) {
                wsTwilio.send(JSON.stringify({
                  event: 'media',
                  streamSid: streamSid,
                  media: { payload: Buffer.from(chunk).toString('base64') }
                }));
              }
            });
          }
        } else {
          console.log(`[⚠️ No connection data found for call SID: ${callSid}]`);
        }
      }
    } catch (err) {
      console.error('[⚠️ WS Parse Error]', err);
    }
  });

  wsTwilio.on('close', () => {
    console.log('[🔌 Twilio WS Disconnected]');
    
    // Clean up connection data for this specific call
    if (callSid && connectionData) {
      cleanupConnection(connectionData);
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
  // Extract the phone number and Call SID from Twilio request
  const phoneNumber = decodeURIComponent(req.body.To || req.body.Called || '');
  const callSid = req.body.CallSid;
  const callerPhoneNumber = decodeURIComponent(req.body.From || '');
  
  console.log(`[📱 Phone number being called: ${phoneNumber}]`);
  console.log(`[📞 Call SID: ${callSid}]`);
  console.log(`[📞 Caller phone number: ${callerPhoneNumber}]`);
  
  // Store call information for WebSocket connection
  callSidToPhone.set(callSid, phoneNumber);
  callSidToCaller.set(callSid, callerPhoneNumber);
  
  // Force invoke Deepgram connection immediately
  forceInvokeDeepgram(callSid, phoneNumber, callerPhoneNumber, (connectionData, error) => {
    if (error) {
      console.log(`[❌ Deepgram connection failed for call ${callSid}: ${error}]`);
    } else {
      console.log(`[✅ Deepgram connection established for call ${callSid}]`);
    }
  });
  
  // Create personalized greeting
  const greeting = `You've reached Botie. I can take your job request, please wait a moment, our representative will be with you shortly`;
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
