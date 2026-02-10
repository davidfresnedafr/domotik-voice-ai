import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import nodemailer from "nodemailer"; 

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const PUBLIC_BASE_URL = "domotik-voice-ai.onrender.com";

// --- TUS CREDENCIALES ---
const MI_CORREO = "df@domotiksolutions.com"; 
const MI_PASSWORD = "2020121058David."; 

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: { user: MI_CORREO, pass: MI_PASSWORD }
});

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
        // ✅ LÓGICA BILINGÜE: Inicia en Inglés, cambia si le hablan en Español
        instructions: `
          Your name is Elena, virtual assistant for Domotik Solutions.
          PRIMARY LANGUAGE: English. You MUST start the conversation in English.
          Only switch to Spanish if the customer speaks Spanish first.
          TONE: Professional and warm.
          GOAL: Schedule technical visits for home automation. Capture name and interest.
          If they say 'goodbye' or 'adiós', say farewell and the call will end.`,
        voice: "shimmer",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: { type: "server_vad", threshold: 0.4, silence_duration_ms: 800 }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());
    if (evt.type === "session.updated") { sessionReady = true; if (streamSid) tryGreet(); }

    if (evt.type === "input_audio_buffer.speech_started") {
      if (streamSid) twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      oaWs.send(JSON.stringify({ type: "response.cancel" }));
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      fullTranscript += `Customer: ${evt.transcript}\n`;
    }
    if (evt.type === "response.audio_transcript.done") {
      fullTranscript += `Elena: ${evt.transcript}\n`;
    }

    if (evt.type === "response.done") {
      const text = (evt.response?.output?.[0]?.content?.[0]?.transcript || "").toLowerCase();
      if (text.includes("goodbye") || text.includes("adiós") || text.includes("bye")) {
        setTimeout(() => { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); }, 2500);
      }
    }
  });

  const tryGreet = () => {
    if (!greeted && sessionReady && streamSid) {
      greeted = true;
      // ✅ SALUDO INICIAL FORZADO EN INGLÉS
      oaWs.send(JSON.stringify({
        type: "response.create",
        response: { 
          modalities: ["audio", "text"], 
          instructions: "Greet clearly in English: 'Thank you for calling Domotik Solutions. This is Elena, how can I help you today?'" 
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

  twilioWs.on("close", async () => {
    const duration = (Date.now() - startTime) / 1000;
    if (duration > 15 && fullTranscript.length > 30) {
      const mailOptions = {
        from: MI_CORREO,
        to: MI_CORREO,
        subject: '🚀 Lead Domotik Solutions - Summary',
        text: `Conversation:\n\n${fullTranscript}\n\nDuration: ${duration.toFixed(2)}s`
      };
      try {
        await transporter.sendMail(mailOptions);
      } catch (e) { console.error("❌ Email error:", e); }
    }
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`<Response><Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect><Pause length="40"/></Response>`);
});

server.listen(PORT, () => console.log(`🚀 Elena Bilingüe activa`));
