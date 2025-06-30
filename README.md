# Deepgram Twilio Streaming Voice Agent

A real-time voice agent that connects Twilio phone calls to Deepgram's Agent API for natural conversations. The agent automatically identifies which tradie (tradesperson) the call is for and personalizes the conversation based on their business information.

## Features

- Real-time voice streaming between Twilio and Deepgram
- Natural conversation with AI agent
- Automatic speech recognition and text-to-speech
- Australian CSR personality for job request collection
- **NEW**: Automatic tradie identification and personalization
- **NEW**: Third-party API integration with secure authentication
- **NEW**: Personalized greetings and responses based on tradie data

## Environment Variables

Create a `.env` file with:

```env
# Deepgram Configuration
DEEPGRAM_API_KEY=your_deepgram_api_key_here

# Server Configuration
PORT=8080

# Third-Party API Configuration
BOTIE_API_BASE_URL=https://your-third-party-api.com/api
API_SHARED_SECRET=your-super-secret-shared-key-here
```

## How It Works

1. **Call Identification**: When a call comes in, the system identifies the tradie using the Twilio Call SID
2. **Data Fetching**: Fetches tradie information from your third-party API using the `getuserbyassignednumber` endpoint with Call SID
3. **Personalization**: Uses tradie data (name, business name) to personalize the conversation
4. **Secure Authentication**: Uses API key authentication with HMAC signatures for secure third-party API communication

## Third-Party API Requirements

Your third-party API should have an endpoint:
- **URL**: `GET /getuserbyassignedSID`
- **Headers**: 
  - `x-api-key`: Generated API key
  - `x-timestamp`: Current timestamp
  - `x-signature`: HMAC signature
  - `call-sid`: The Twilio Call SID
- **Response**: JSON with tradie information (e.g., `{ "name": "John Smith", "profession": "plumber", "professionDescription": "Residential and commercial plumbing services" }`)

## Local Development

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
npm start
```

3. The server will run on `http://localhost:8080`

## Render Deployment

1. Connect your GitHub repository to Render
2. Create a new Web Service
3. Set the following:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Environment Variables**:
     - `DEEPGRAM_API_KEY`: Your Deepgram API key
     - `PORT`: 8080 (or leave empty for Render's default)
     - `BOTIE_API_BASE_URL`: Your third-party API base URL
     - `API_SHARED_SECRET`: Your shared secret for API authentication

4. Deploy!

## Twilio Configuration

Set your Twilio webhook URL to:
```
https://your-render-app.onrender.com/twiml
```

## Usage

1. Call any tradie number configured in your system
2. The agent will automatically identify the tradie using the Call SID and personalize the conversation
3. The agent will greet callers with the tradie's name and business
4. The conversation will end when the agent says "Goodbye"

## Architecture

- **Express.js**: HTTP server for Twilio webhooks
- **WebSocket**: Real-time audio streaming
- **Deepgram Agent API**: Speech recognition, AI processing, and text-to-speech
- **Twilio Media Streams**: Phone call audio streaming
- **Third-Party API Integration**: Secure API communication for tradie data
- **Session Management**: Call-specific tradie data storage and cleanup
