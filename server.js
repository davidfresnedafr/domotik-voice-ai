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
  let silenceTimer = null;

  const oaWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
  });

  // FUNCIÓN PARA COLGAR POR SILENCIO (10 SEGUNDOS)
  const resetSilenceTimer = () => {
    if (silenceTimer) clearTimeout(silenceTimer);
    silenceTimer = setTimeout(() => {
      console.log("🤫 Silencio prolongado. Colgando...");
      twilioWs.close();
    }, 15000); // 15 segundos de margen
  };

  oaWs.on("open", () => {
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `Your name is Elena from Domotik Solutions.
        PRESENTATION: "Hi! I'm Elena from Domotik Solutions. We install and repair Smart Home systems and Business Security. How can I help you today?"
        
        MANDATORY DATA: 1. Customer Name, 2. Phone Number, 3. Address, 4. Issue.
        RULES:
        - Don't give prices. 
        - If they say 'Bye', say 'Have a nice day' and STOP.
        - Be very brief.`,
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad", threshold: 0.4, silence_duration_ms: 800 }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());
    
    // Si hay cualquier evento de voz, reseteamos el temporizador de silencio
    if (evt.type === "input_audio_buffer.speech_started") {
      resetSilenceTimer();
      if (streamSid) {
        twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
        oaWs.send(JSON.stringify({ type: "response.cancel" }));
      }
    }

    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      const text = evt.transcript.toLowerCase();
      fullTranscript.push(`Cliente: ${evt.transcript}`);
      if (text.includes("bye") || text.includes("adios") || text.includes("goodbye")) {
        setTimeout(() => { twilioWs.close(); }, 1500);
      }
    }

    if (evt.type === "response.audio_transcript.done") {
      fullTranscript.push(`Elena: ${evt.transcript}`);
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }
  });

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") { 
        streamSid = msg.start.streamSid; 
        resetSilenceTimer(); // Iniciamos cronómetro al empezar
    }
    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", async () => {
    clearTimeout(silenceTimer);
    if (fullTranscript.length > 2) {
      const chat = fullTranscript.join('\n');
      
      // EXTRACCIÓN MEJORADA: Buscamos patrones de teléfono y palabras clave
      const phoneMatch = chat.match(/(\d[\s-]?){7,12}/g);
      const phone = phoneMatch ? phoneMatch[phoneMatch.length - 1] : "Not captured";
      
      try {
        await client.messages.create({
          body: `🏠 *ORDEN DOMOTIK SOLUTIONS*\n\n📞 TELÉFONO: ${phone}\n\n📋 DETALLE COMPLETO:\n${chat.slice(-1000)}`,
          from: TWILIO_WHATSAPP, to: MI_WHATSAPP
        });
      } catch (e) { console.error("Error WhatsApp:", e.message); }
    }
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  // Forzamos el saludo inicial directo de Twilio
  twiml.say({ voice: 'Polly.Joanna' }, 'Connecting to Domotik Solutions.');
  twiml.connect().stream({ url: `wss://${PUBLIC_BASE_URL}/media-stream` });
  res.type("text/xml").send(twiml.toString());
});

server.listen(PORT, () => console.log(`🚀 Elena v24.0 Sniper-Dispatch Ready`));
