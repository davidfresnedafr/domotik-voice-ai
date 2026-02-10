import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "domotik-voice-ai.onrender.com";

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
      console.log("🚀 Listo (session + streamSid). Enviando saludo...");

      // (Opcional) limpia buffer por si llega audio residual
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.clear" }));

      // ✅ FORZAR AUDIO (esto arregla el “no suena nada”)
      oaWs.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio"],
            instructions: "Hello, how can I help you today?",
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
          instructions:
            "You are a Domotik assistant. Speak English primarily, Spanish if the user does. Be concise.",
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
    } catch (e) {
      console.error("❌ No pude parsear mensaje de OpenAI:", e);
      return;
    }

    if (evt.type === "session.updated") {
      sessionReady = true;
      console.log("✅ session.updated");
      tryGreet();
    }

    // ✅ Audio de OpenAI -> Twilio
    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: evt.delta },
        })
      );
    }

    // ✅ Logs de transcripción (para debug)
    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      console.log("🎙️ IA ENTENDIÓ:", evt.transcript);
    }

    // ✅ Debug útil
    if (evt.type === "response.completed") {
      console.log("✅ response.completed");
    }

    if (evt.type === "error") {
      console.error("❌ ERROR DE OPENAI:", evt.error);
    }
  });

  oaWs.on("close", (code, reason) => {
    console.log("⚠️ OpenAI WS cerrado:", code, reason?.toString?.() || "");
  });

  oaWs.on("error", (err) => {
    console.error("❌ OpenAI WS error:", err);
  });

  twilioWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      console.error("❌ No pude parsear mensaje de Twilio:", e);
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      console.log("📞 TWILIO RECIBIENDO AUDIO - ID:", streamSid);

      // (Opcional) limpia buffer al inicio
      if (oaWs.readyState === WebSocket.OPEN) {
        oaWs.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
      }

      tryGreet();
    }

    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      process.stdout.write("."); // confirma flujo de audio
      oaWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload,
        })
      );
    }

    if (msg.event === "stop") {
      console.log("🛑 TWILIO stop");
    }
  });

  twilioWs.on("close", () => {
    console.log("🏁 Llamada terminada");
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });

  twilioWs.on("error", (err) => {
    console.error("❌ Twilio WS error:", err);
  });
});

// Webhook Twilio Voice (TwiML)
app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`
<Response>
  <Say language="en-US">Connecting now.</Say>
  <Connect>
    <Stream url="wss://${PUBLIC_BASE_URL}/media-stream" />
  </Connect>
  <Pause length="40"/>
</Response>`);
});

app.get("/", (req, res) => res.send("OK"));

server.listen(PORT, () => console.log(`🚀 Sistema en puerto ${PORT}`));
