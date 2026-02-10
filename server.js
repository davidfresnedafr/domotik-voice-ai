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
        instructions: `Tu nombre es Elena, de Domotik Solutions.
        1. PERSONALIDAD: Eres una asistente humana, cálida y muy profesional.
        2. ACENTO ESPAÑOL: Estricto Bogotá, Colombia (Rola). Usa "Usted", nunca "Tú". 
           Usa frases como: "Con mucho gusto", "¿En qué le puedo colaborar?", "Permítame un momento".
        3. ACENTO INGLÉS: Americano neutro y fluido.
        4. REGLA DE ORO: Si el usuario te interrumpe, CÁLLATE de inmediato.
        5. BREVEDAD: No hables más de lo necesario. Sé directa pero amable.`,
        voice: "shimmer",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { 
          type: "server_vad", 
          threshold: 0.4, 
          prefix_padding_ms: 200,
          silence_duration_ms: 600 
        }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());

    if (evt.type === "session.updated") { sessionReady = true; if (streamSid) sendGreeting(); }

    // Interrupción inmediata (Para que sea humana, debe dejar hablar)
    if (evt.type === "input_audio_buffer.speech_started") {
      if (streamSid) twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      oaWs.send(JSON.stringify({ type: "response.cancel" }));
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    if (evt.type === "response.done") {
      const text = evt.response?.output?.[0]?.content?.[0]?.transcript?.toLowerCase() || "";
      if (text.includes("bye") || text.includes("adiós") || text.includes("luego")) {
        setTimeout(() => { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); }, 1500);
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
          instructions: "Greet warmly in English: 'Hello! You're speaking with the assistant from Domotik Solutions... How can I help you today?'" 
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
  res.type("text/xml").send(`<Response><Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect><Pause length="1"/></Response>`);
});

server.listen(PORT, () => console.log(`🚀 Elena: Humana y Bilingüe`));
