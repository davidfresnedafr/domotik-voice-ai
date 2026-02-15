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
        
        PITCH INICIAL: "Hi! I'm Elena from Domotik Solutions. We install and repair Smart Home systems and Business Security. We do Residential and Commercial work. How can I help you today?"

        REGLAS DE HIERRO:
        1. EL TELÉFONO ES PRIMERO: Antes de pedir la dirección, di: "I need your phone number first to register the service".
        2. NO AVANCES si no te dan el número.
        3. CAPTURA: Nombre, Teléfono, Dirección y problema técnico.
        4. BREVEDAD: Máximo 12 palabras por respuesta.`,
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad", threshold: 0.4, silence_duration_ms: 600 }
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
      fullTranscript.push(`Cliente: ${evt.transcript}`);
      
      if (text.includes("bye") || text.includes("adiós") || text.includes("gracias bye")) {
        setTimeout(() => { twilioWs.close(); }, 2000);
      }
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    if (evt.type === "response.audio_transcript.done") {
      fullTranscript.push(`Elena: ${evt.transcript}`);
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
      const allText = fullTranscript.join(' ');
      // Regex mejorado para capturar números de teléfono dictados
      const phoneMatch = allText.match(/(\d[\s-]?){7,11}/g); 
      const extractedPhone = phoneMatch ? phoneMatch[0].replace(/\s/g, '') : "⚠️ NO CAPTURADO";

      try {
        await client.messages.create({
          body: `🚀 *NUEVA ORDEN DE SERVICIO*\n\n📞 TELÉFONO: ${extractedPhone}\n\n📝 CHAT:\n${fullTranscript.join('\n').slice(-800)}`,
          from: TWILIO_WHATSAPP, to: MI_WHATSAPP
        });
      } catch (e) { console.error("Error WhatsApp:", e.message); }
    }
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  // El saludo de Twilio ahora es más corto para dejar que Elena haga el pitch
  twiml.say({ voice: 'Polly.Joanna' }, 'Connecting to Domotik Solutions.');
  twiml.connect().stream({ url: `wss://${PUBLIC_BASE_URL}/media-stream` });
  res.type("text/xml").send(twiml.toString());
});

server.listen(PORT, () => console.log(`🚀 Elena v21.0 Sniper Active`));
