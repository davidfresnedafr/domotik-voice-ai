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
        instructions: `Your name is Elena from Domotik Solutions.
        - INTRODUCTION: "Hi! I'm Elena from Domotik Solutions. We provide smart home and commercial automation services. How can I help you today?"
        - MISSION: You must get: 1. Phone number, 2. Full address, 3. The specific service or issue.
        - NO PRICES: Never give prices. Say a technician will provide a quote after inspection.
        - BREVITY: Maximum 15 words per response.
        - TERMINATION: When they say 'Bye', stop and hang up.`,
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad", threshold: 0.4, silence_duration_ms: 700 }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());
    
    if (evt.type === "input_audio_buffer.speech_started" && streamSid) {
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      oaWs.send(JSON.stringify({ type: "response.cancel" }));
    }

    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      const text = evt.transcript.toLowerCase();
      fullTranscript.push(`C: ${evt.transcript}`);
      if (text.includes("bye") || text.includes("adios") || text.includes("goodbye")) {
        setTimeout(() => { twilioWs.close(); }, 1500);
      }
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    if (evt.type === "response.audio_transcript.done") {
      fullTranscript.push(`E: ${evt.transcript}`);
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
      const chat = fullTranscript.join('\n');
      
      // Lógica de extracción para reporte limpio
      const phoneMatch = chat.match(/(\d[\s-]?){7,11}/g);
      const phone = phoneMatch ? phoneMatch[phoneMatch.length - 1].replace(/\s/g, '') : "Not provided";
      
      try {
        await client.messages.create({
          body: `🏠 *DOMOTIK JOB ORDER*\n\n📞 PHONE: ${phone}\n📍 INFO: (Check chat below for address/service)\n\n📝 TRANSCRIPT:\n${chat.slice(-800)}`,
          from: TWILIO_WHATSAPP, to: MI_WHATSAPP
        });
      } catch (e) { console.error("Error WhatsApp:", e.message); }
    }
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  // El saludo inicial ahora es en inglés y profesional
  twiml.say({ voice: 'Polly.Joanna', language: 'en-US' }, 'Welcome to Domotik Solutions. Connecting you now.');
  twiml.connect().stream({ url: `wss://${PUBLIC_BASE_URL}/media-stream` });
  res.type("text/xml").send(twiml.toString());
});

server.listen(PORT, () => console.log(`🚀 Elena v23.0 Final Sniper Ready`));
