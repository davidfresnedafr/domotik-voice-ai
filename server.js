import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const PUBLIC_BASE_URL = "domotik-voice-ai.onrender.com";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

wss.on("connection", (twilioWs) => {
  let streamSid = null;
  let greeted = false;
  let sessionReady = false;

  const oaWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
  });

  oaWs.on("open", () => {
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `Your name is Elena, virtual assistant for Domotik Solutions. 
        START ALWAYS IN ENGLISH. This is mandatory. 
        Only switch to Spanish if the customer speaks Spanish.
        Tone: Professional, warm, and helpful.`,
        voice: "shimmer",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: { type: "server_vad", threshold: 0.4, silence_duration_ms: 800 }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());
    if (evt.type === "session.updated") { sessionReady = true; if (streamSid) tryGreet(); }
    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }
  });

  const tryGreet = () => {
    if (!greeted && sessionReady && streamSid) {
      greeted = true;
      oaWs.send(JSON.stringify({
        type: "response.create",
        response: { 
          modalities: ["audio", "text"], 
          instructions: "Greet in English: 'Thank you for calling Domotik Solutions. This is Elena, how can I help you today?'" 
        }
      }));
    }
  };

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") { streamSid = msg.start.streamSid; tryGreet(); }
    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", () => { if (oaWs.readyState === WebSocket.OPEN) oaWs.close(); });
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`<Response><Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect><Pause length="40"/></Response>`);
});

server.listen(PORT, () => console.log(`🚀 Elena Online (Sin correos por ahora)`));
