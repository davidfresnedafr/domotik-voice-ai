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
  console.log("📞 Cliente conectado");
  let streamSid = null;
  let fullTranscript = [];

  const oaWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
  });

  oaWs.on("open", () => {
    console.log("🟢 Conexión con OpenAI exitosa");
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `Your name is Elena from Domotik Solutions. 
        PITCH: "Hi! I'm Elena from Domotik Solutions. We install and repair Smart Home systems and Business Security. How can I help you today?"
        - MISSION: You MUST get Name, Phone Number, and Address. 
        - BE BRIEF. No prices. If they say 'Bye', the call ends.`,
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
      if (evt.transcript.toLowerCase().includes("bye")) setTimeout(() => twilioWs.close(), 1500);
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

      // Usamos slice(-1200) para evitar el error de 1600 caracteres de Twilio
      await client.messages.create({
        body: `🏠 *REPORTE DOMOTIK*\n📞 TEL: ${phone}\n\n📝 RESUMEN:\n${summary.slice(-1200)}`,
        from: TWILIO_WHATSAPP, to: MI_WHATSAPP
      }).catch(e => console.error("Error SMS:", e.message));
    }
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`
    <Response>
      <Say voice="Polly.Joanna">Welcome to Domotik Solutions. Connecting to Elena.</Say>
      <Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect>
    </Response>
  `);
});

// Reinicio limpio del servidor
server.close(() => {
  server.listen(PORT, () => console.log(`🚀 v26.0 Corriendo en puerto ${PORT}`));
});
server.listen(PORT);
