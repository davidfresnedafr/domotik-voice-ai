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
          instructions: "First Greeting: 'Hello! This is Elena from Domotik Solutions. How can I assist you with your project today?'" 
        }
      }));
    }
  };

  oaWs.on("open", () => {
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `Your name is Elena, assistant at Domotik Solutions. 
        - CRITICAL: You are talking to a customer on SPEAKERPHONE. 
        - IGNORE all echoes and background mumbles. 
        - If you hear something that sounds like your own previous words, DO NOT RESPOND.
        - Wait for a CLEAR, LOUD human voice before answering.
        - If they want an appointment, get: Name, Address, and Time.`,
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: { 
          type: "server_vad", 
          threshold: 0.4, // Bajamos el threshold pero...
          prefix_padding_ms: 500,
          silence_duration_ms: 1500 // ...aumentamos el silencio para que no se interrumpa sola
        }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());

    if (evt.type === "session.updated") {
      setTimeout(sendGreeting, 2500); 
    }

    // Si la IA detecta que el cliente empezó a hablar, limpiamos el buffer de salida
    // Esto evita que el eco se acumule
    if (evt.type === "input_audio_buffer.speech_started") {
        console.log("Voz detectada - Limpiando eco");
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    if (evt.type === "response.audio_transcript.done") {
        fullTranscript += `Elena: ${evt.transcript}\n`;
    }
    if (evt.type === "conversation.item.input_audio_transcription.completed") {
        // FILTRO DE SEGURIDAD: Si la transcripción es idéntica a lo que ella dijo, la ignoramos.
        const transcript = evt.transcript.toLowerCase();
        if (transcript.length > 5 && !transcript.includes("domotik solutions")) {
            fullTranscript += `Cliente: ${evt.transcript}\n`;
        }
    }
  });

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      if (oaWs.readyState === WebSocket.OPEN) {
        oaWs.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
      }
    }
    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", async () => {
    if (fullTranscript.length > 20) {
        try {
            await client.messages.create({
                body: `🏠 *Lead Report - Domotik*\n\n${fullTranscript}`,
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
      <Connect>
        <Stream url="wss://${PUBLIC_BASE_URL}/media-stream">
          <Parameter name="inboundTracks" value="inbound_audio" />
        </Stream>
      </Connect>
    </Response>`);
});

server.listen(PORT, () => console.log(`🚀 Elena v11.0 Echo-Killer Ready`));
