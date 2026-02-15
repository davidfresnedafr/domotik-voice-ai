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

  const sendGreeting = () => {
    if (!greeted && streamSid) {
      greeted = true;
      oaWs.send(JSON.stringify({
        type: "response.create",
        response: { 
          modalities: ["audio", "text"], 
          instructions: "Greet clearly: 'Hello! This is Elena from Domotik Solutions. How can I help you today?'" 
        }
      }));
    }
  };

  oaWs.on("open", () => {
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `Eres Elena de Domotik Solutions. 
        - REGLA CRÍTICA: Estás en modo altavoz. Ignora ecos.
        - No respondas a frases de una sola palabra como 'Thank you' o 'Hello' si suenan a eco.
        - Idioma: Inglés primero, español después.`,
        voice: "shimmer",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: { 
          type: "server_vad", 
          threshold: 0.99, // ⬅️ Nivel máximo para matar el eco
          prefix_padding_ms: 1000,
          silence_duration_ms: 2000 // ⬅️ Más tiempo de espera para confirmar que el humano terminó
        }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());

    if (evt.type === "session.updated" && streamSid && !greeted) {
        setTimeout(sendGreeting, 3000); // ⬅️ 3 segundos para que el canal esté limpio
    }

    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      // FILTRO: Si lo que "escuchó" es muy corto, no lo agregues al reporte (es eco)
      if (evt.transcript.trim().length > 5) {
        fullTranscript += `Cliente: ${evt.transcript}\n`;
      }
    }
    
    if (evt.type === "response.audio_transcript.done") {
      fullTranscript += `Elena: ${evt.transcript}\n`;
    }

    // ELIMINAR INTERRUPCIONES POR ECO
    if (evt.type === "input_audio_buffer.speech_started") {
       // No limpiamos el buffer inmediatamente para evitar cortes por ruido blanco
       console.log("Detección de voz (posible eco)...");
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }
  });

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") { streamSid = msg.start.streamSid; }
    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", async () => {
    if (fullTranscript.length > 30) {
      try {
        await client.messages.create({
          body: `🏠 *Resumen Domotik*\n\n${fullTranscript}`,
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

server.listen(PORT, () => console.log(`🚀 Elena v5.5 (Anti-Eco)`));
