import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";

// Configuración de Entorno
const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const PUBLIC_BASE_URL = "domotik-voice-ai.onrender.com";

// Configuración Twilio (Asegúrate de tener estas Vars en Render)
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID;
const TWILIO_AUTH_TOKEN = process.env.TWILIO_AUTH_TOKEN;
const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

const MI_WHATSAPP = "whatsapp:+15617141075"; 
const TWILIO_WHATSAPP = "whatsapp:+14155238886"; 

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

wss.on("connection", (twilioWs) => {
  let streamSid = null;
  let greeted = false;
  let fullTranscript = ""; 

  // Conexión con el cerebro de OpenAI
  const oaWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: { 
        Authorization: `Bearer ${OPENAI_API_KEY}`, 
        "OpenAI-Beta": "realtime=v1" 
    }
  });

  // Función para saludar al cliente
  const sendGreeting = () => {
    if (!greeted && streamSid) {
      greeted = true;
      console.log("🚀 Enviando saludo inicial a South Florida...");
      oaWs.send(JSON.stringify({
        type: "response.create",
        response: { 
          modalities: ["audio", "text"], 
          instructions: "Greet: 'Hello! You're speaking with Elena from Domotik Solutions. We specialize in premium home automation here in South Florida. How may I assist you with your project today?'" 
        }
      }));
    }
  };

  oaWs.on("open", () => {
    console.log("✅ Conexión con OpenAI establecida.");
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `Eres Elena, asistente de Domotik Solutions. 
        - UBICACIÓN: Solo South Florida (Miami, Fort Lauderdale, Palm Beach).
        - TONO: High-end, elegante, acento de Bogotá (Usted).
        - REGLA DE ORO: No hables por ruidos de fondo. Solo si escuchas una voz humana clara.
        - CIERRE: Si el cliente se despide (bye, gracias, adiós), termina la frase y cuelga.`,
        voice: "shimmer",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: { 
          type: "server_vad", 
          threshold: 0.95, // ⬅️ Umbral máximo para eliminar el soplido del micro
          prefix_padding_ms: 600,
          silence_duration_ms: 1200 
        }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());

    // Disparar saludo cuando la sesión esté lista
    if (evt.type === "session.updated") {
      setTimeout(() => { if (streamSid) sendGreeting(); }, 1000);
    }

    // Guardar transcripción para el WhatsApp
    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      fullTranscript += `Cliente: ${evt.transcript}\n`;
    }
    if (evt.type === "response.audio_transcript.done") {
      fullTranscript += `Elena: ${evt.transcript}\n`;
    }

    // Si el cliente interrumpe, Elena calla
    if (evt.type === "input_audio_buffer.speech_started") {
      if (streamSid) twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      oaWs.send(JSON.stringify({ type: "response.cancel" }));
    }

    // Enviar audio de Elena a Twilio
    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    // Lógica de colgado automático
    if (evt.type === "response.done") {
      const text = evt.response?.output?.[0]?.content?.[0]?.transcript?.toLowerCase() || "";
      const despedidas = ["bye", "adiós", "chao", "luego", "gracias", "thanks"];
      if (despedidas.some(d => text.includes(d))) {
        console.log("Cierre detectado.");
        setTimeout(() => { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); }, 2500);
      }
    }
  });

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      console.log("📞 Llamada recibida. Stream:", streamSid);
    }
    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", async () => {
    console.log("🏁 Fin de llamada. Procesando reporte de WhatsApp...");
    if (fullTranscript.length > 20) {
      try {
        await client.messages.create({
          body: `🏠 *Nuevo Lead - Domotik Solutions*\n\n${fullTranscript}`,
          from: TWILIO_WHATSAPP,
          to: MI_WHATSAPP
        });
        console.log("✅ Reporte enviado a tu WhatsApp.");
      } catch (err) {
        console.error("❌ Error enviando reporte:", err.message);
      }
    }
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

// Endpoint TwiML para Twilio
app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`
    <Response>
      <Connect>
        <Stream url="wss://${PUBLIC_BASE_URL}/media-stream" />
      </Connect>
      <Pause length="1"/>
    </Response>`);
});

server.listen(PORT, () => console.log(`🚀 Elena: Operativa en Florida puerto ${PORT}`));
