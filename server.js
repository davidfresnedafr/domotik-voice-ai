import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const PUBLIC_BASE_URL = "domotik-voice-ai.onrender.com";

if (!OPENAI_API_KEY) {
  console.error("❌ Falta OPENAI_API_KEY en variables de entorno");
}

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

wss.on("connection", (twilioWs) => {
  let streamSid = null;
  let greeted = false;
  let sessionReady = false;

  const oaWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  const tryGreet = () => {
    if (!greeted && streamSid && sessionReady && oaWs.readyState === WebSocket.OPEN) {
      greeted = true;
      console.log("🚀 Iniciando conversación con voz Echo...");
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
      oaWs.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"], 
          instructions: "Greeting: 'Hola, bienvenido a Domotik Solutions. Soy su asistente virtual, ¿en qué puedo ayudarle hoy?'",
        },
      }));
    }
  };

  oaWs.on("open", () => {
    console.log("✅ OpenAI conectado - Voz: Echo");
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `
          Eres el Asistente de Ventas de Domotik Solutions. 
          PERSONALIDAD: Habla con seguridad, calma y profesionalismo.
          OBJETIVO: Agendar visitas técnicas de domótica.
          REGLA DE CIERRE: Si el cliente dice 'adiós' o 'bye', despídete y cuelga.
          INTERRUPCIÓN: Detente de inmediato si el cliente te habla.`,
        // ✅ VOZ ECHO: Es la opción más robusta y humana disponible.
        voice: "echo", 
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: {
          type: "server_vad",
          threshold: 0.4,
          prefix_padding_ms: 300,
          silence_duration_ms: 500,
        },
      },
    }));
  });

  oaWs.on("message", (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch (e) { return; }

    if (evt.type === "session.updated") { sessionReady = true; tryGreet(); }

    // GESTIÓN DE INTERRUPCIONES
    if (evt.type === "input_audio_buffer.speech_started") {
      console.log("🤫 Cliente hablando: Deteniendo IA...");
      if (streamSid) { twilioWs.send(JSON.stringify({ event: "clear", streamSid })); }
      oaWs.send(JSON.stringify({ type: "response.cancel" }));
    }

    // ENVÍO DE AUDIO
    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: evt.delta },
      }));
    }

    // LÓGICA DE CIERRE AUTOMÁTICO
    if (evt.type === "response.done") {
      const transcript = evt.response?.output?.[0]?.content?.[0]?.transcript || "";
      const text = transcript.toLowerCase();
      if (text.includes("adiós") || text.includes("bye") || text.includes("hasta luego")) {
        console.log("🏁 Despedida detectada. Cerrando llamada...");
        setTimeout(() => { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); }, 2500);
      }
    }

    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      console.log("\n🎙️ CLIENTE:", evt.transcript);
    }
  });

  twilioWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch (e) { return; }
    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      console.log("📞 Llamada activa:", streamSid);
      tryGreet();
    }
    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", () => { 
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close(); 
  });
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`
<Response>
  <Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect>
  <Pause length="40"/>
</Response>`);
});

server.listen(PORT, () => console.log(`🚀 Sistema Domotik con voz 'Echo' activo`));
