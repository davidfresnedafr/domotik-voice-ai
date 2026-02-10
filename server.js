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

  const tryGreet = () => {
    if (!greeted && streamSid && sessionReady && oaWs.readyState === WebSocket.OPEN) {
      greeted = true;
      console.log("🚀 Enviando saludo corregido...");
      // ✅ MODALIDADES CORREGIDAS SEGÚN image_af31a5.png
      oaWs.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"], 
          instructions: "Say: 'Hello, welcome to Domotik Solutions. How can I help you today?'",
        }
      }));
    }
  };

  oaWs.on("open", () => {
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: "You are a bilingual assistant. English primary. Respond in Spanish if the user does. Be very concise.",
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { 
          type: "server_vad", 
          threshold: 0.2, // Máxima sensibilidad para detectar tu voz
          silence_duration_ms: 500 
        }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());
    if (evt.type === "session.updated") { sessionReady = true; tryGreet(); }
    
    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    if (evt.type === "error") console.error("❌ ERROR:", evt.error);
  });

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") { streamSid = msg.start.streamSid; tryGreet(); }
    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      process.stdout.write("."); // Esto confirma que te escuchamos
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", () => { if (oaWs.readyState === WebSocket.OPEN) oaWs.close(); });
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`
    <Response>
      <Say language="en-US">Connecting to Domotik.</Say>
      <Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect>
      <Pause length="40"/>
    </Response>`);
});

server.listen(PORT, () => console.log(`🚀 Listo en puerto ${PORT}`));
