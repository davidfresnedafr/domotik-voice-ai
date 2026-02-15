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
  console.log("📞 Twilio conectado al WebSocket");
  let streamSid = null;
  let fullTranscript = []; 

  const oaWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
  });

  oaWs.on("open", () => {
    console.log("🟢 Conectado a OpenAI Realtime");
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `Your name is Elena from Domotik Solutions. 
        PRESENTATION: "Hi! I'm Elena from Domotik Solutions. We install and repair Smart Home systems and Business Security. Residential and Commercial. How can I help you today?"
        MISSION: You MUST get Name, Phone Number, and Address. 
        BE BRIEF. If they say 'Bye', the call will end.`,
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 800 }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());

    // Manejo de Interrupción (Barge-in)
    if (evt.type === "input_audio_buffer.speech_started" && streamSid) {
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      oaWs.send(JSON.stringify({ type: "response.cancel" }));
    }

    // Audio de OpenAI a Twilio
    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    // Captura de Transcripciones
    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      fullTranscript.push(`Cliente: ${evt.transcript}`);
      if (evt.transcript.toLowerCase().includes("bye")) {
        setTimeout(() => twilioWs.close(), 2000);
      }
    }
    if (evt.type === "response.audio_transcript.done") {
      fullTranscript.push(`Elena: ${evt.transcript}`);
    }
  });

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      console.log(`🚀 Stream iniciado. ID: ${streamSid}`);
    }
    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", async () => {
    console.log("🔴 Llamada finalizada.");
    if (fullTranscript.length > 1) {
      const summary = fullTranscript.join('\n');
      const phoneMatch = summary.match(/(\d[\s-]?){7,12}/g);
      const phone = phoneMatch ? phoneMatch[phoneMatch.length - 1] : "No detectado";

      await client.messages.create({
        body: `🏠 *REPORTE DOMOTIK*\n📞 TEL: ${phone}\n\n📝 CHAT:\n${summary.slice(-900)}`,
        from: TWILIO_WHATSAPP, to: MI_WHATSAPP
      });
    }
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

// XML DE TWILIO CORREGIDO
app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`
    <Response>
      <Say voice="Polly.Joanna">Connecting to Domotik Solutions.</Say>
      <Connect>
        <Stream url="wss://${PUBLIC_BASE_URL}/media-stream" />
      </Connect>
    </Response>
  `);
});

server.listen(PORT, () => console.log(`🚀 Servidor en Puerto ${PORT}`));

server.listen(PORT, () => console.log(`🚀 Elena v24.0 Sniper-Dispatch Ready`));
