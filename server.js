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
          instructions: "SAY THIS EXACTLY IN ENGLISH: 'Thank you for calling Domotik Solutions. This is Elena. How can I assist you with your project today?' Do not translate this to Spanish yet." 
        }
      }));
    }
  };

  oaWs.on("open", () => {
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `Your name is Elena, a high-end assistant for Domotik Solutions. 
        - STRICT RULE: You must speak ENGLISH. Only switch to Spanish if the user speaks a full sentence in Spanish. 
        - DO NOT respond to background noise or short mumbles.
        - If you hear noise, stay silent.`,
        voice: "alloy",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: { 
          type: "server_vad", 
          threshold: 0.6, // ⬅️ Bajamos a 0.6 para que SÍ te escuche
          prefix_padding_ms: 600,
          silence_duration_ms: 1500 // ⬅️ Espera más para no interrumpirte
        }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());

    if (evt.type === "session.updated" && streamSid) {
      setTimeout(sendGreeting, 2500); 
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    if (evt.type === "response.audio_transcript.done") { fullTranscript += `Elena: ${evt.transcript}\n`; }
    if (evt.type === "conversation.item.input_audio_transcription.completed") { 
        // Solo guardamos si hay contenido real
        if (evt.transcript.trim().length > 2) {
            fullTranscript += `Cliente: ${evt.transcript}\n`;
        }
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
    if (fullTranscript.length > 15) {
        try {
            await client.messages.create({
                body: `🏠 *Domotik Lead Report*\n\n${fullTranscript}`,
                from: TWILIO_WHATSAPP, to: MI_WHATSAPP
            });
        } catch (e) { console.error("WhatsApp Error:", e.message); }
    }
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`<Response><Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect></Response>`);
});

server.listen(PORT, () => console.log(`🚀 Elena v7.0 Ready`));
