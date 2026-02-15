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
  console.log("📞 Nueva llamada conectada");
  let streamSid = null;
  let fullTranscript = [];

  const oaWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
  });

  oaWs.on("open", () => {
    console.log("🟢 OpenAI Realtime Listo");
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `Your name is Elena from Domotik Solutions. 
        OFFICIAL GREETING: "Hi! I'm Elena from Domotik Solutions. We install and repair Smart Home systems and Business Security for Residential and Commercial clients. How can I help you today?"
        
        STRICT RULES:
        1. You MUST get: Name, Phone Number, and Address. 
        2. BE BRIEF: Under 12 words per response.
        3. NO PRICES: Say 'A technician will provide a quote after the visit.'
        4. HANG UP: If they say 'Bye', stop talking.`,
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 800 }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());

    if (evt.type === "input_audio_buffer.speech_started" && streamSid) {
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      oaWs.send(JSON.stringify({ type: "response.cancel" }));
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      fullTranscript.push(`Cliente: ${evt.transcript}`);
      if (evt.transcript.toLowerCase().includes("bye")) setTimeout(() => twilioWs.close(), 1200);
    }
    
    if (evt.type === "response.audio_transcript.done") {
      fullTranscript.push(`Elena: ${evt.transcript}`);
    }
  });

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") streamSid = msg.start.streamSid;
    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", async () => {
    if (fullTranscript.length > 2) {
      const summary = fullTranscript.join('\n');
      const phoneMatch = summary.match(/(\d[\s-]?){7,12}/g);
      const phone = phoneMatch ? phoneMatch[phoneMatch.length - 1].replace(/\s/g, '') : "⚠️ Not Found";

      // Evitamos el error de límite de caracteres
      await client.messages.create({
        body: `🚀 *DOMOTIK JOB ORDER*\n📞 PHONE: ${phone}\n\n📝 SUMMARY:\n${summary.slice(-1100)}`,
        from: TWILIO_WHATSAPP, to: MI_WHATSAPP
      }).catch(e => console.error("WhatsApp Error:", e.message));
    }
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`
    <Response>
      <Say voice="Polly.Joanna">Connecting to Domotik Solutions.</Say>
      <Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect>
    </Response>
  `);
});

// Solución definitiva al error ERR_SERVER_ALREADY_LISTEN
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 v27.0 Online on Port ${PORT}`);
});
