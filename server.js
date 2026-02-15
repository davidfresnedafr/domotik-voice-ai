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
      console.log("🚀 Lanza saludo: Domotik Solutions");
      oaWs.send(JSON.stringify({
        type: "response.create",
        response: { 
          modalities: ["audio", "text"], 
          instructions: "Greeting (Speak clearly): 'Hello! Thank you for calling Domotik Solutions. This is Elena. How can I assist you with your project today?'" 
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
        - PRIORITY: Always stay in English. 
        - Switch to Spanish ONLY if the client speaks a full sentence in Spanish.
        - If they say 'Hello' or 'Hola', answer in English first.
        - You are on speakerphone, be patient.`,
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: { 
          type: "server_vad", 
          threshold: 0.5, 
          prefix_padding_ms: 500,
          silence_duration_ms: 1200 
        }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());

    // Si recibimos confirmación de que la respuesta se creó, la enviamos a Twilio
    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    if (evt.type === "response.audio_transcript.done") {
        fullTranscript += `Elena: ${evt.transcript}\n`;
    }
    if (evt.type === "conversation.item.input_audio_transcription.completed") {
        const t = evt.transcript.toLowerCase();
        if (t.length > 3) fullTranscript += `Cliente: ${evt.transcript}\n`;
    }
  });

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    
    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      console.log("📞 Llamada iniciada. Esperando estabilización...");
    }
    
    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      // ENVIAR SALUDO SOLO DESPUÉS DE RECIBIR EL PRIMER PAQUETE DE AUDIO REAL
      if (!greeted) {
        setTimeout(sendGreeting, 1500); // 1.5 segundos de margen de seguridad
      }
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", async () => {
    if (fullTranscript.length > 15) {
        try {
            await client.messages.create({
                body: `🏠 *Lead Update: Domotik*\n\n${fullTranscript}`,
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
        <Stream url="wss://${PUBLIC_BASE_URL}/media-stream" />
      </Connect>
      <Pause length="2"/> 
    </Response>`);
});

server.listen(PORT, () => console.log(`🚀 Elena v12.0 Ready`));
