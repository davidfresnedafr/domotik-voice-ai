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
    if (
      !greeted &&
      streamSid &&
      sessionReady &&
      oaWs.readyState === WebSocket.OPEN
    ) {
      greeted = true;
      console.log("🚀 Lógica lista. Enviando saludo corregido...");

      oaWs.send(JSON.stringify({ type: "input_audio_buffer.clear" }));

      // ✅ SOLUCIÓN AL ERROR DE IMAGE_AF31A5.PNG:
      // Se agregaron ambas modalidades ['audio', 'text'] para que OpenAI acepte la petición.
      oaWs.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio", "text"], 
            instructions: "Greeting: 'Hello, welcome to Domotik Solutions, how can I help you today?'",
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
          instructions: "You are a Domotik assistant. Speak English primarily, Spanish if the user does. Be concise.",
          voice: "alloy",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.3,
            prefix_padding_ms: 500,
            silence_duration_ms: 600,
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
      console.log("✅ Configuración de sesión aplicada");
      tryGreet();
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      // Enviamos audio a Twilio
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: evt.delta },
        })
      );
    }

    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      console.log("🎙️ Usuario dijo:", evt.transcript);
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
      console.log("📞 Llamada iniciada. ID Twilio:", streamSid);
      tryGreet();
    }

    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload,
        })
      );
    }
  });

  twilioWs.on("close", () => {
    console.log("🏁 Conexión cerrada");
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`
<Response>
  <Say language="en-US">Connecting.</Say>
  <Connect>
    <Stream url="wss://${PUBLIC_BASE_URL}/media-stream" />
  </Connect>
  <Pause length="40"/>
</Response>`);
});

app.get("/", (req, res) => res.send("Servidor Domotik Activo"));

server.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
