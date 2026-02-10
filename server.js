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
        instructions: `Eres Elena de Domotik Solutions. 
        - IMPORTANTE: El cliente podría estar en ALTAVOZ. Ignora ruidos de fondo y soplidos.
        - Sé breve y usa acento de Bogotá (Usted).
        - No cuelgues a menos que sea una despedida definitiva.`,
        voice: "shimmer",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { 
          type: "server_vad", 
          threshold: 0.7, // ⬅️ SUBIMOS a 0.7 para ignorar el soplido del micro
          prefix_padding_ms: 300,
          silence_duration_ms: 1000 // ⬅️ Damos más tiempo para que no corte frases
        }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());
    if (evt.type === "session.updated") { sessionReady = true; if (streamSid) sendGreeting(); }

    // Interrupción: Solo si el sonido es FUERTE (voz real)
    if (evt.type === "input_audio_buffer.speech_started") {
      if (streamSid) twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      oaWs.send(JSON.stringify({ type: "response.cancel" }));
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    // Colgado de seguridad: Solo con palabras muy claras
    if (evt.type === "response.done") {
      const text = evt.response?.output?.[0]?.content?.[0]?.transcript?.toLowerCase() || "";
      const despedidaReal = ["chao elena", "adiós elena", "terminar llamada", "finalizar llamada"];
      if (despedidaReal.some(word => text.includes(word))) {
        setTimeout(() => { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); }, 2000);
      }
    }
  });

  const sendGreeting = () => {
    if (!greeted && streamSid && sessionReady) {
      greeted = true;
      oaWs.send(JSON.stringify({
        type: "response.create",
        response: { 
          modalities: ["audio", "text"], 
          instructions: "Greet: 'Hello! You're speaking with the assistant from Domotik Solutions. How can I help you today?'" 
        }
      }));
    }
  };

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") { streamSid = msg.start.streamSid; if (sessionReady) sendGreeting(); }
    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", () => { if (oaWs.readyState === WebSocket.OPEN) oaWs.close(); });
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`
    <Response>
      <Connect>
        <Stream url="wss://${PUBLIC_BASE_URL}/media-stream">
          <Parameter name="track" value="both_tracks" />
        </Stream>
      </Connect>
      <Pause length="1"/>
    </Response>`);
});

server.listen(PORT, () => console.log(`🚀 Elena: Lista para Altavoz y Micro`));
