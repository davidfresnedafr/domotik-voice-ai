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
        instructions: `Eres Elena de Domotik Solutions. 
        PRESENTACIÓN: "Hola, soy Elena de Domotik Solutions. Ofrecemos automatización residencial y comercial. ¿En qué puedo ayudarte hoy?"
        
        REGLAS CRÍTICAS:
        1. DEBES PEDIR EL NÚMERO DE TELÉFONO SIEMPRE. Es obligatorio para el reporte.
        2. Pregunta: ¿Es para un servicio residencial o comercial?
        3. Pide Dirección y Nombre.
        
        CIERRE:
        - Si dicen "Bye" o "Gracias", despídete brevemente. El sistema colgará solo.
        - Mantén las respuestas de menos de 15 palabras.`,
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad", threshold: 0.4, silence_duration_ms: 600 }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());
    
    // BARGE-IN: Si el cliente habla, Elena se calla
    if (evt.type === "input_audio_buffer.speech_started" && streamSid) {
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      oaWs.send(JSON.stringify({ type: "response.cancel" }));
    }

    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      const text = evt.transcript.toLowerCase();
      fullTranscript.push(`Cliente: ${evt.transcript}`);
      
      // AUTO-HANGUP
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
      // Extraemos números de teléfono del texto para ponerlos arriba
      const allText = fullTranscript.join(' ');
      const phoneMatch = allText.match(/\d{7,10}/g); // Busca secuencias de 7 a 10 números
      const extractedPhone = phoneMatch ? phoneMatch.join(' / ') : "No capturado en voz";

      try {
        await client.messages.create({
          body: `🚀 *NUEVA ORDEN TÉCNICA*\n\n📞 TELÉFONO CLIENTE: ${extractedPhone}\n\n📝 DETALLE:\n${fullTranscript.join('\n').slice(-700)}`,
          from: TWILIO_WHATSAPP, to: MI_WHATSAPP
        });
      } catch (e) { console.error("Error WhatsApp:", e.message); }
    }
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  // Twilio saluda primero para asegurar audio inmediato
  twiml.say({ voice: 'Polly.Joanna' }, 'Connecting to Domotik Solutions residential and commercial support.');
  twiml.connect().stream({ url: `wss://${PUBLIC_BASE_URL}/media-stream` });
  res.type("text/xml").send(twiml.toString());
});

server.listen(PORT, () => console.log(`🚀 Elena v20.0 Ready`));
