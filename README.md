# Deepgram Twilio Streaming Voice Agent

A real-time voice agent that connects Twilio phone calls to Deepgram's Agent API for natural conversations.

## Features

- Real-time voice streaming between Twilio and Deepgram
- Natural conversation with AI agent
- Automatic speech recognition and text-to-speech
- Australian CSR personality for job request collection

## Environment Variables

Create a `.env` file with:

```env
DEEPGRAM_API_KEY=your_deepgram_api_key_here
PORT=8080
```

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

4. Deploy!

## Twilio Configuration

Set your Twilio webhook URL to:
```
https://your-render-app.onrender.com/twiml
```

## Usage

1. Call your Twilio phone number
2. The agent will greet you and collect job request details
3. The conversation will end when the agent says "Goodbye"

## Architecture

- **Express.js**: HTTP server for Twilio webhooks
- **WebSocket**: Real-time audio streaming
- **Deepgram Agent API**: Speech recognition, AI processing, and text-to-speech
- **Twilio Media Streams**: Phone call audio streaming
