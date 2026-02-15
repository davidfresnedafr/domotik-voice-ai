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
      console.log("🚀 Enviando saludo inicial...");
      oaWs.send(JSON.stringify({
        type: "response.create",
        response: { 
          modalities: ["audio", "text"], 
          instructions: "Introduce yourself: 'Hello! You are speaking with Elena from Domotik Solutions. How can I assist you with your automation project today?'" 
        }
      }));
    }
  };

  oaWs.on("open", () => {
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: "Your name is Elena from Domotik Solutions. Speak clearly. English is primary. If the user speaks Spanish, switch to Spanish. You are a professional assistant.",
        voice: "alloy", // Voz más clara para evitar distorsión
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { 
          type: "server_vad", 
          threshold: 0.85, // ⬅️ Nivel equilibrado para evitar el 'ruido'
          prefix_padding_ms: 500,
          silence_duration_ms: 1000 
        }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());

    if (evt.type === "session.updated" && streamSid && !greeted) {
        setTimeout(sendGreeting, 1500); // Reducido a 1.5s para que sea más natural
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    // Captura de texto para reporte
    if (evt.type === "response.audio_transcript.done") {
        fullTranscript += `Elena: ${evt.transcript}\n`;
    }
    if (evt.type === "conversation.item.input_audio_transcription.completed") {
        fullTranscript += `Cliente: ${evt.transcript}\n`;
    }
  });

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      // Limpiamos cualquier ruido inicial del buffer
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
    }
    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", async () => {
    if (fullTranscript.length > 10) {
        try {
            await client.messages.create({
                body: `🏠 *Resumen Domotik*\n\n${fullTranscript}`,
                from: TWILIO_WHATSAPP,
                to: MI_WHATSAPP
            });
        } catch (e) { console.error("Error WhatsApp:", e.message); }
    }
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`
    <Response>
      <Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect>
      <Pause length="1"/>
    </Response>`);
});

server.listen(PORT, () => console.log(`🚀 Elena v6.0 Online`));
