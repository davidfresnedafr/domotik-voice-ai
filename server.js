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
  let fullTranscript = []; 

  const oaWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
  });

  oaWs.on("open", () => {
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `Eres Elena de Domotik Solutions. Tu ÚNICO objetivo es llenar esta ficha:
        1. Servicio solicitado.
        2. Dirección completa.
        3. Nombre del cliente.
        4. Hora para mañana.

        REGLAS:
        - No des explicaciones largas de lo que hacemos.
        - Si el cliente no te da la dirección, pídela amablemente otra vez.
        - Sé extremadamente breve (máximo 15 palabras por respuesta).
        - Si el cliente habla, cállate inmediatamente.`,
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { 
            type: "server_vad", 
            threshold: 0.4, 
            silence_duration_ms: 600 // Respuesta rápida para que no haya baches
        }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());
    
    // CORTE DE AUDIO INSTANTÁNEO (BARGE-IN)
    if (evt.type === "input_audio_buffer.speech_started" && streamSid) {
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      oaWs.send(JSON.stringify({ type: "response.cancel" }));
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    if (evt.type === "response.audio_transcript.done") { fullTranscript.push(`Elena: ${evt.transcript}`); }
    if (evt.type === "conversation.item.input_audio_transcription.completed") { 
      fullTranscript.push(`Cliente: ${evt.transcript}`); 
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
    if (fullTranscript.length > 2) {
      // Creamos un resumen limpio buscando solo las líneas con datos
      const summary = fullTranscript.join('\n');
      try {
        await client.messages.create({
          body: `🛠️ *NUEVA ORDEN DE SERVICIO*\n\nDATOS CAPTURADOS:\n${summary.slice(-700)}`,
          from: TWILIO_WHATSAPP, to: MI_WHATSAPP
        });
      } catch (e) { console.error("Error WhatsApp:", e.message); }
    }
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  // Saludo inicial forzado para que no haya silencio
  twiml.say({ voice: 'Polly.Joanna', language: 'en-US' }, 'Hi! Thanks for calling Domotik Solutions. Elena is here to help you.');
  twiml.connect().stream({ url: `wss://${PUBLIC_BASE_URL}/media-stream` });
  res.type("text/xml").send(twiml.toString());
});

server.listen(PORT, () => console.log(`🚀 Elena v18.0 Closer Active`));
