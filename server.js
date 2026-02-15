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
        PRESENTACIÓN: "Hola, soy Elena. Instalamos y reparamos Smart Homes y Seguridad Comercial/Residencial. ¿En qué te ayudo?"

        REGLAS DE ORO:
        1. PRECIOS: NUNCA des precios. Di: "Nuestros técnicos enviarán el presupuesto tras la visita".
        2. TELÉFONO Y DIRECCIÓN: Son obligatorios. Si no te los dan, insiste: "Necesito tu teléfono y dirección para enviar al técnico".
        3. FICHA: Antes de colgar debes tener: Nombre, Teléfono, Dirección y Problema.
        4. BREVEDAD: No hables de más. Sé directa.`,
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad", threshold: 0.4, silence_duration_ms: 700 }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());
    
    // CORTE SI EL CLIENTE HABLA
    if (evt.type === "input_audio_buffer.speech_started" && streamSid) {
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      oaWs.send(JSON.stringify({ type: "response.cancel" }));
    }

    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      const text = evt.transcript.toLowerCase();
      fullTranscript.push(`C: ${evt.transcript}`);
      // Solo cuelga si hay despedida CLARA
      if (text.includes("bye") || text.includes("adiós") || text.includes("hasta luego")) {
        setTimeout(() => { twilioWs.close(); }, 2000);
      }
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    if (evt.type === "response.audio_transcript.done") {
      fullTranscript.push(`E: ${evt.transcript}`);
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
      const chat = fullTranscript.join('\n');
      
      // Intentamos extraer el teléfono del chat
      const phoneMatch = chat.match(/(\d[\s-]?){7,11}/g);
      const extractedPhone = phoneMatch ? phoneMatch[phoneMatch.length - 1].replace(/\s/g, '') : "❌ NO CAPTURADO";

      try {
        await client.messages.create({
          body: `🛠️ *REPORTE DE SERVICIO DOMOTIK*\n\n📞 TELÉFONO: ${extractedPhone}\n\n📝 CONVERSACIÓN:\n${chat.slice(-900)}`,
          from: TWILIO_WHATSAPP, to: MI_WHATSAPP
        });
      } catch (e) { console.error("Error WhatsApp:", e.message); }
    }
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  const twiml = new twilio.twiml.VoiceResponse();
  twiml.say({ voice: 'Polly.Joanna', language: 'es-US' }, 'Conectando con Domotik Solutions. Espere un momento.');
  twiml.connect().stream({ url: `wss://${PUBLIC_BASE_URL}/media-stream` });
  res.type("text/xml").send(twiml.toString());
});

server.listen(PORT, () => console.log(`🚀 Elena v22.0 Ready`));
