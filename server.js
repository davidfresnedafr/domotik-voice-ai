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
    if (!greeted && streamSid && oaWs.readyState === WebSocket.OPEN) {
      greeted = true;
      oaWs.send(JSON.stringify({
        type: "response.create",
        response: { 
          modalities: ["audio", "text"], 
          instructions: "Greeting: 'Thanks for calling Domotik Solutions. This is Elena. How can I help you today?' (Keep it short!)" 
        }
      }));
    }
  };

  oaWs.on("open", () => {
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `Your name is Elena from Domotik Solutions. 
        - BE VERY BRIEF. Do not explain services unless asked.
        - MISSION: Get the Service needed, Address, and Date/Time for the visit.
        - INTERRUPTION: If the user speaks, stop talking immediately.
        - LANGUAGE: English primarily. Spanish only if they speak it.`,
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { 
          type: "server_vad", 
          threshold: 0.5, 
          prefix_padding_ms: 200,
          silence_duration_ms: 800 // Respuesta más rápida
        }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());

    // SI EL USUARIO HABLA, MANDAMOS SEÑAL DE "CLEAR" A TWILIO PARA QUE ELENA SE CALLE
    if (evt.type === "input_audio_buffer.speech_started") {
      if (streamSid) {
        twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
        oaWs.send(JSON.stringify({ type: "response.cancel" }));
      }
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    if (evt.type === "response.audio_transcript.done") { fullTranscript += `E: ${evt.transcript}\n`; }
    if (evt.type === "conversation.item.input_audio_transcription.completed") { fullTranscript += `C: ${evt.transcript}\n`; }
    
    if (evt.type === "session.updated") { setTimeout(sendGreeting, 1500); }
  });

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") { streamSid = msg.start.streamSid; }
    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", async () => {
    if (fullTranscript.length > 10) {
      try {
        // SOLICITAMOS RESUMEN FINAL A OPENAI ANTES DE CERRAR (OPCIONAL) O FILTRAMOS AQUÍ:
        await client.messages.create({
          body: `🏠 *DOMOTIK LEAD*\n\n${fullTranscript.slice(-600)}`, // Solo mandamos los últimos 600 caracteres para evitar error de límite
          from: TWILIO_WHATSAPP, to: MI_WHATSAPP
        });
      } catch (e) { console.error("Error SMS:", e.message); }
    }
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`<Response><Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect></Response>`);
});

server.listen(PORT, () => console.log(`🚀 Elena v14.0 Ready`));
