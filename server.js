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
  let fullTranscript = ""; 
  let startTime = Date.now();

  const oaWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
  });

  oaWs.on("open", () => {
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `Your name is Elena, assistant for Domotik Solutions.
        - START ALWAYS IN ENGLISH.
        - If the customer speaks Spanish, switch to a professional Bogotá (Colombian) accent.
        - If you say 'bye', 'goodbye', or 'adiós', the call must end.
        - Be professional, helpful, and concise.`,
        voice: "shimmer",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 1000 }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());
    if (evt.type === "session.updated") sessionReady = true;

    // Guardar transcripción en memoria para verla en logs
    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      fullTranscript += `Cliente: ${evt.transcript}\n`;
    }
    if (evt.type === "response.audio_transcript.done") {
      fullTranscript += `Elena: ${evt.transcript}\n`;
    }

    // Lógica para colgar
    if (evt.type === "response.done") {
      const text = evt.response?.output?.[0]?.content?.[0]?.transcript?.toLowerCase() || "";
      if (text.includes("bye") || text.includes("goodbye") || text.includes("adiós")) {
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
      // Espera 2 segundos después de conectar para lanzar el saludo
      setTimeout(() => {
        oaWs.send(JSON.stringify({
          type: "response.create",
          response: { 
            modalities: ["audio", "text"], 
            instructions: "Greet exactly: 'Hello, you are speaking with the assistant from Domotik Solutions. How can I help you?'" 
          }
        }));
      }, 2000); 
    }
  };

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") { streamSid = msg.start.streamSid; tryGreet(); }
    
    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      const uptime = (Date.now() - startTime) / 1000;
      // NO ESCUCHAR los primeros 5 segundos para evitar ruidos de conexión
      if (uptime > 5) {
        oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
      }
    }
  });

  twilioWs.on("close", () => {
    console.log("--- CONVERSACIÓN FINALIZADA ---");
    console.log(fullTranscript || "No se capturó texto.");
    console.log("-------------------------------");
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`<Response><Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect><Pause length="40"/></Response>`);
});

server.listen(PORT, () => console.log(`🚀 Elena: Lista y estable en puerto ${PORT}`));
