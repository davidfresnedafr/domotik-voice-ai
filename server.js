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
        instructions: `
          Your name is Elena, assistant for Domotik Solutions.
          
          TONE & ACCENT:
          - English: Use a professional, neutral American accent.
          - Spanish: Use a polite, professional accent from Bogotá, Colombia (Rolo). 
            Use phrases like "Con mucho gusto", "A la orden", "Cuénteme en qué puedo colaborarle".
          
          BEHAVIOR:
          - You MUST start the conversation in English with the specific greeting provided.
          - Switch to Spanish only if the customer speaks Spanish.
          - If the user says goodbye (bye, goodbye, adiós, hasta luego), say a brief farewell and the call will hang up.`,
        voice: "shimmer",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { 
          type: "server_vad", 
          threshold: 0.5,
          prefix_padding_ms: 300,
          silence_duration_ms: 800 
        }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());
    if (evt.type === "session.updated") { sessionReady = true; if (streamSid) tryGreet(); }
    
    // Interrupción: Elena se calla si el cliente habla
    if (evt.type === "input_audio_buffer.speech_started") {
        if (streamSid) twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
        oaWs.send(JSON.stringify({ type: "response.cancel" }));
    }

    // Lógica de Auto-colgado
    if (evt.type === "response.done") {
      const transcript = evt.response?.output?.[0]?.content?.[0]?.transcript?.toLowerCase() || "";
      const farewells = ["bye", "goodbye", "adiós", "hasta luego", "que tenga un buen día"];
      
      if (farewells.some(word => transcript.includes(word))) {
        setTimeout(() => {
          if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
        }, 2000); 
      }
    }

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
          // ✅ SALUDO SOLICITADO
          instructions: "Greet exactly like this: 'Hello, you are speaking with the assistant from Domotik Solutions. How can I help you?'" 
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

server.listen(PORT, () => console.log(`🚀 Elena: Saludo personalizado activo`));
