import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const PUBLIC_BASE_URL = "domotik-voice-ai.onrender.com";

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const MI_WHATSAPP = "whatsapp:+15617141075"; 
const TWILIO_WHATSAPP = "whatsapp:+14155238886"; 

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

wss.on("connection", (twilioWs) => {
  let streamSid = null;
  let greeted = false;
  let fullTranscript = ""; 

  const oaWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
  });

  // SALUDO CON RETRASO PARA ASEGURAR CONEXIÓN
  const sendGreeting = () => {
    if (!greeted && streamSid) {
      greeted = true;
      console.log("📢 Enviando saludo sincronizado...");
      oaWs.send(JSON.stringify({
        type: "response.create",
        response: { 
          modalities: ["audio", "text"], 
          instructions: "Greet immediately in English: 'Thank you for calling Domotik Solutions, leaders in premium automation. This is Elena, how can I help you today?'" 
        }
      }));
    }
  };

  oaWs.on("open", () => {
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `Your name is Elena, assistant at Domotik Solutions.
        - IMPORTANT: You are on speakerphone. Ignore your own echo and background noise.
        - PRIMARY LANGUAGE: English. If the client speaks Spanish, reply in Spanish with a professional Colombian accent.
        - END OF CALL: Summarize the lead (Name, Phone, Address, Service needed) internally for the transcript.`,
        voice: "shimmer",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: { 
          type: "server_vad", 
          threshold: 0.98, // ⬅️ Máximo nivel: casi sorda al ruido, solo escucha voces directas
          prefix_padding_ms: 800,
          silence_duration_ms: 1800 // ⬅️ Espera más para no interrumpir en altavoz
        }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());

    // SALUDO: Esperamos a que Twilio esté listo
    if (evt.type === "session.updated" && streamSid && !greeted) {
        setTimeout(sendGreeting, 2500); // 2.5 segundos de gracia
    }

    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      fullTranscript += `Cliente: ${evt.transcript}\n`;
    }
    if (evt.type === "response.audio_transcript.done") {
      fullTranscript += `Elena: ${evt.transcript}\n`;
    }

    if (evt.type === "input_audio_buffer.speech_started") {
      if (streamSid) twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      oaWs.send(JSON.stringify({ type: "response.cancel" }));
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    if (evt.type === "response.done") {
      const text = evt.response?.output?.[0]?.content?.[0]?.transcript?.toLowerCase() || "";
      if (["bye", "adiós", "thanks", "gracias"].some(d => text.includes(d))) {
        setTimeout(() => { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); }, 3000);
      }
    }
  });

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") { streamSid = msg.start.streamSid; console.log("📞 Stream conectado"); }
    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", async () => {
    // 📩 WHATSAPP RESUMIDO
    if (fullTranscript.length > 20) {
      try {
        // Pedimos a la API de Twilio enviar solo lo importante
        const resumenLineas = fullTranscript.split('\n');
        const resumenFiltrado = resumenLineas.filter(l => l.includes("2835") || l.includes("Mañana") || l.includes("Cliente:")).join('\n');

        await client.messages.create({
          body: `🏠 *Nuevo Lead Domotik*\n\n${fullTranscript.slice(-400)}`, // Envía los últimos 400 caracteres (el cierre)
          from: TWILIO_WHATSAPP,
          to: MI_WHATSAPP
        });
      } catch (e) { console.error("Error SMS:", e.message); }
    }
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`<Response><Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect></Response>`);
});

server.listen(PORT, () => console.log(`🚀 Elena v5.0 Lista`));
