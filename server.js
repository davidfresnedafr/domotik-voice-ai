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
  let fullTranscript = ""; // Para guardar la información de la charla

  const oaWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
  });

  oaWs.on("open", () => {
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `Eres Elena de Domotik Solutions. 
        1. SALUDO: Empieza siempre en inglés.
        2. BILINGÜE: Si el cliente habla español, cambia INMEDIATAMENTE a acento bogotano.
        3. DESPEDIDA: Si dices "bye", "adiós" o "hasta luego", la llamada terminará.
        4. REGLA: Sé profesional y breve.`,
        voice: "shimmer",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 800 }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());
    
    if (evt.type === "session.updated") { sessionReady = true; }

    // Capturar lo que dice el cliente y Elena
    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      fullTranscript += `Cliente: ${evt.transcript}\n`;
    }
    if (evt.type === "response.audio_transcript.done") {
      fullTranscript += `Elena: ${evt.transcript}\n`;
    }

    // Lógica para COLGAR
    if (evt.type === "response.done") {
      const text = evt.response?.output?.[0]?.content?.[0]?.transcript?.toLowerCase() || "";
      if (text.includes("bye") || text.includes("adiós") || text.includes("hasta luego")) {
        setTimeout(() => { twilioWs.close(); }, 2000);
      }
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }
  });

  const tryGreet = () => {
    if (!greeted && sessionReady && streamSid) {
      greeted = true;
      // ESPERA DE 2 SEGUNDOS antes de saludar para limpiar la línea
      setTimeout(() => {
        oaWs.send(JSON.stringify({
          type: "response.create",
          response: { 
            modalities: ["audio", "text"], 
            instructions: "Greet: 'Hello, you are speaking with the assistant from Domotik Solutions. How can I help you?'" 
          }
        }));
      }, 2000); 
    }
  };

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") { streamSid = msg.start.streamSid; tryGreet(); }
    
    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      // SILENCIO INICIAL: No enviamos audio a la IA los primeros 5 segundos de la conexión
      const uptime = (Date.now() - startTime) / 1000;
      if (uptime > 5) {
        oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
      }
    }
  });

  let startTime = Date.now();
  twilioWs.on("close", () => {
    console.log("--- RESUMEN DE LA CONVERSACIÓN ---");
    console.log(fullTranscript);
    console.log("----------------------------------");
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`<Response><Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect><Pause length="40"/></Response>`);
});

server.listen(PORT, () => console.log(`🚀 Elena corregida: Saludo y Bilingüismo`));
