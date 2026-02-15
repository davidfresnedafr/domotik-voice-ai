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
          instructions: "Short Greeting: 'Domotik Solutions, Elena speaking. How can I help?'" 
        }
      }));
    }
  };

  oaWs.on("open", () => {
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `You are Elena. BE EXTREMELY BRIEF.
        1. Ask for the service needed.
        2. Ask for the address.
        3. Ask for the date and time.
        STOP TALKING immediately if the user speaks. Do not use filler phrases like 'I understand' or 'Sure'.`,
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { 
          type: "server_vad", 
          threshold: 0.4, // Más sensible para detectar interrupciones rápido
          prefix_padding_ms: 100,
          silence_duration_ms: 600 // Reacción casi instantánea
        }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());

    // INTERRUPCIÓN CRÍTICA (BARGE-IN)
    if (evt.type === "input_audio_buffer.speech_started") {
      console.log("🤫 Cliente hablando: Callando a Elena...");
      if (streamSid) {
        // Detiene el audio en Twilio inmediatamente
        twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      }
      // Detiene la generación en OpenAI
      oaWs.send(JSON.stringify({ type: "response.cancel" }));
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    if (evt.type === "response.audio_transcript.done") { fullTranscript += `E: ${evt.transcript}\n`; }
    if (evt.type === "conversation.item.input_audio_transcription.completed") { 
      if (evt.transcript.trim().length > 2) fullTranscript += `C: ${evt.transcript}\n`; 
    }
    
    if (evt.type === "session.updated") { setTimeout(sendGreeting, 1200); }
  });

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") { streamSid = msg.start.streamSid; }
    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", async () => {
    if (fullTranscript.length > 5) {
      // FILTRO DE DATOS: Solo enviamos lo importante para evitar saturación de WhatsApp
      const lines = fullTranscript.split('\n');
      const filteredInfo = lines.filter(l => 
        /\d/.test(l) || l.toLowerCase().includes("street") || 
        l.toLowerCase().includes("ave") || l.toLowerCase().includes("appointment")
      ).join('\n');

      try {
        await client.messages.create({
          body: `🏠 *DOMOTIK DATA*\n\n${filteredInfo || "Ver chat completo: \n" + fullTranscript.slice(-400)}`,
          from: TWILIO_WHATSAPP, to: MI_WHATSAPP
        });
      } catch (e) { console.error("Error SMS:", e.message); }
    }
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`
    <Response>
      <Connect>
        <Stream url="wss://${PUBLIC_BASE_URL}/media-stream">
          <Parameter name="inboundTracks" value="both_tracks" />
        </Stream>
      </Connect>
    </Response>`);
});

server.listen(PORT, () => console.log(`🚀 Elena v15.0 Sniper Ready`));
