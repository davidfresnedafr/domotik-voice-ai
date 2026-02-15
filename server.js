import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";

// --- CONFIGURACIÓN DE VARIABLES ---
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
    // 1. Configuración de la IA
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `Your name is Elena from Domotik Solutions. 
        PITCH: "Hi! I'm Elena from Domotik Solutions. We install and repair Smart Home systems and Business Security for Residential and Commercial clients. How can I help you today?"
        GOAL: Collect Name, Phone, and Address.
        TERMINATION: If the user says 'Bye', 'Goodbye', 'Adiós' or 'Thank you', say 'Goodbye' and the call will end.
        RULES: Be direct. No filler words.`,
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 800 }
      }
    }));

    // 2. Saludo Proactivo Inmediato
    oaWs.send(JSON.stringify({
      type: "response.create",
      response: {
        instructions: "Introduce yourself immediately with the official pitch."
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
      const text = evt.transcript.toLowerCase();
      fullTranscript.push(`Cliente: ${evt.transcript}`);
      
      // Cierre fulminante por palabras clave
      const despedidas = ["bye", "goodbye", "adiós", "adios", "gracias", "thank you"];
      if (despedidas.some(p => text.includes(p))) {
        setTimeout(() => {
          if (streamSid) client.calls(streamSid).update({ status: 'completed' }).catch(() => {});
          twilioWs.close();
        }, 1800);
      }
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
      const chat = fullTranscript.join('\n');

      // --- MOTOR DE EXTRACCIÓN PUNTUAL ---
      
      // 1. Teléfono: Busca cualquier serie de 7 a 12 números
      const phoneMatch = chat.match(/(\d[\s-]?){7,12}/g);
      const phone = phoneMatch ? phoneMatch[phoneMatch.length - 1].replace(/\s|-/g, '') : "⚠️ NO DETECTADO";

      // 2. Nombre: Busca después de frases de presentación comunes
      const nameMatch = chat.match(/Cliente: (?:hi|hello|this is|my name is|i am|soy|me llamo|habla) ([\w\s]+)/i);
      const name = nameMatch ? nameMatch[1].split('\n')[0].trim() : "Revisar chat";

      // 3. Dirección: Busca patrones de numeración + calle (incluyendo español)
      const addressMatch = chat.match(/(?:\d+\s+[\w\s]+(?:street|st|ave|avenue|dr|drive|rd|road|lane|ln|blvd|calle|avenida|casa|apt))/i);
      const address = addressMatch ? addressMatch[0] : "Revisar chat";

      // --- ENVÍO DE WHATSAPP ---
      try {
        await client.messages.create({
          body: `🚀 *NUEVA ORDEN TÉCNICA*\n\n` +
                `👤 *NOMBRE:* ${name.toUpperCase()}\n` +
                `📞 *TELÉFONO:* ${phone}\n` +
                `📍 *DIRECCIÓN:* ${address}\n\n` +
                `--------------------------\n` +
                `📝 *TRANSCRIPCIÓN RESUMIDA:*\n${chat.slice(-800)}`,
          from: TWILIO_WHATSAPP, 
          to: MI_WHATSAPP
        });
        console.log("✅ Reporte puntual enviado.");
      } catch (e) {
        console.error("❌ Error enviando WhatsApp:", e.message);
      }
    }
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

// Endpoint para Twilio
app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`
    <Response>
      <Connect>
        <Stream url="wss://${PUBLIC_BASE_URL}/media-stream" />
      </Connect>
    </Response>
  `);
});

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 v31.0 Dispatcher Ready on Port ${PORT}`));
