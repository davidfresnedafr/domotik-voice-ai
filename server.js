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
      console.log("🚀 Canal listo. Lanzando saludo...");

      oaWs.send(JSON.stringify({ type: "input_audio_buffer.clear" }));

      // Enviamos el saludo con ambas modalidades para cumplir con los requisitos de la API
      oaWs.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio", "text"], 
            instructions: "Greet the user: 'Hello, welcome to Domotik Solutions, how can I help you today?'",
          },
        })
      );
    }
  };

  oaWs.on("open", () => {
    console.log("✅ OpenAI WS conectado");
    oaWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          instructions: "You are a Domotik assistant. Bilingual (English/Spanish). Be concise.",
          voice: "alloy",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.2, // Sensibilidad optimizada para detectar voz clara
            prefix_padding_ms: 500,
            silence_duration_ms: 500,
          },
        },
      })
    );
  });

  oaWs.on("message", (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw.toString());
    } catch (e) { return; }

    if (evt.type === "session.updated") {
      sessionReady = true;
      tryGreet();
    }

    // Este log confirma que OpenAI está enviando paquetes de audio de vuelta
    if (evt.type === "response.created") {
      console.log("🤖 OpenAI está generando audio...");
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      // Reenvío de los paquetes de audio a Twilio
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: evt.delta },
        })
      );
    }

    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      console.log("\n🎙️ IA ENTENDIÓ:", evt.transcript);
    }

    if (evt.type === "error") {
      console.error("❌ ERROR DE OPENAI:", evt.error);
    }
  });

  twilioWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) { return; }

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      console.log("📞 TWILIO RECIBIENDO AUDIO - ID:", streamSid);
      tryGreet();
    }

    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      process.stdout.write("."); // Muestra flujo de entrada en tiempo real
      oaWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload,
        })
      );
    }
  });

  twilioWs.on("close", () => {
    console.log("\n🏁 Llamada terminada");
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

// XML de Twilio simplificado para evitar interferencias de audio
app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`
<Response>
  <Connect>
    <Stream url="wss://${PUBLIC_BASE_URL}/media-stream" />
  </Connect>
  <Pause length="40"/>
</Response>`);
});

app.get("/", (req, res) => res.send("Servidor Domotik en Línea"));

server.listen(PORT, () => console.log(`🚀 Sistema activo en puerto ${PORT}`));
