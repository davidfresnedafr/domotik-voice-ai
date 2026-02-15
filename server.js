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

  // Solo saludamos si el WebSocket de OpenAI está en estado OPEN (1)
  const sendGreeting = () => {
    if (!greeted && streamSid && oaWs.readyState === WebSocket.OPEN) {
      greeted = true;
      console.log("🚀 Enviando saludo oficial en Inglés...");
      oaWs.send(JSON.stringify({
        type: "response.create",
        response: { 
          modalities: ["audio", "text"], 
          instructions: "Greeting: 'Thank you for calling Domotik Solutions. This is Elena. How can I assist you with your project today?'" 
        }
      }));
    }
  };

  oaWs.on("open", () => {
    console.log("✅ Conectado a OpenAI");
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: "Your name is Elena from Domotik Solutions. PRIMARY LANGUAGE: ENGLISH. Only speak Spanish if the client does. You are a high-end concierge.",
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { 
          type: "server_vad", 
          threshold: 0.8, // Bajamos un poco para evitar que se 'corte' el audio
          prefix_padding_ms: 500,
          silence_duration_ms: 1200 
        }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());

    // SALUDO: Solo cuando la sesión está lista y el socket abierto
    if (evt.type === "session.updated") {
      setTimeout(sendGreeting, 2000); 
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    if (evt.type === "response.audio_transcript.done") { fullTranscript += `Elena: ${evt.transcript}\n`; }
    if (evt.type === "conversation.item.input_audio_transcription.completed") { fullTranscript += `Cliente: ${evt.transcript}\n`; }
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
            await client.messages.create({
                body: `🏠 *Nuevo Reporte Domotik*\n\n${fullTranscript}`,
                from: TWILIO_WHATSAPP, to: MI_WHATSAPP
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
    </Response>`);
});

server.listen(PORT, () => console.log(`🚀 Elena v6.5 Online`));
