import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

// =========================
// CONFIG
// =========================
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL; // ej: tu-app.onrender.com
const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
const REALTIME_MODEL = process.env.REALTIME_MODEL || "gpt-realtime";

// =========================
// APP
// =========================
const app = express();
app.use(express.urlencoded({ extended: false }));

// Log de requests
app.use((req, _res, next) => {
  console.log(`➡️ ${req.method} ${req.path}`);
  next();
});

// Health checks
app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/healthz", (_req, res) => res.status(200).send("OK"));

// =========================
// SERVER
// =========================
const server = http.createServer(app);

// =========================
// WEBSOCKET (Twilio Media Stream)
// =========================
const wss = new WebSocketServer({ server, path: "/media-stream" });

function openaiWsUrl(model) {
  return `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
}

wss.on("connection", (twilioWs) => {
  console.log("✅ Twilio connected to /media-stream");

  let streamSid = null;

  // -------------------------
  // OpenAI Realtime WS
  // -------------------------
  const oaWs = new WebSocket(openaiWsUrl(REALTIME_MODEL), {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  oaWs.on("open", () => {
    console.log("✅ OpenAI Realtime connected");

    // Configuración de sesión (audio fluido, barge-in, bilingüe)
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: `
You are the Domotik Solutions voice assistant.
You handle CCTV, access control, networking and smart home services.
If the caller speaks Spanish, respond in Spanish.
Be concise and professional.
If the caller asks for a human or it’s urgent, say you will transfer the call.
        `.trim(),
        audio: {
          input: { format: "g711_ulaw" },
          output: { format: "g711_ulaw", voice: "marin" },
        },
        turn_detection: {
          type: "server_vad",
          create_response: true,
          interrupt_response: true,
        },
      },
    }));

    // 👉 La IA HABLA PRIMERO
    oaWs.send(JSON.stringify({
      type: "response.create",
      response: {
        instructions: "Hello, this is Domotik Solutions. How can I help you today?"
      }
    }));
  });

  // -------------------------
  // Twilio → OpenAI (audio)
  // -------------------------
  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      console.log("📞 Stream started:", streamSid);
      return;
    }

    if (msg.event === "media" && msg.media?.payload) {
      if (oaWs.readyState === WebSocket.OPEN) {
        oaWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload, // base64 g711_ulaw
        }));
      }
      return;
    }

    if (msg.event === "stop") {
      console.log("🛑 Stream stopped");
      try { oaWs.close(); } catch {}
    }
  });

  // -------------------------
  // OpenAI → Twilio (audio)
  // -------------------------
  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());

    // Interrupción (barge-in)
    if (evt.type === "input_audio_buffer.speech_started" && streamSid) {
      twilioWs.send(JSON.stringify({
        event: "clear",
        streamSid,
      }));
      return;
    }

    // Audio de la IA hacia la llamada
    if (
      (evt.type === "response.audio.delta" ||
       evt.type === "response.output_audio.delta") &&
      evt.delta &&
      streamSid
    ) {
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: evt.delta },
      }));
    }

    if (evt.type === "error") {
      console.log("❌ OpenAI error:", evt.error);
    }
  });

  oaWs.on("close", () => console.log("ℹ️ OpenAI WS closed"));

  twilioWs.on("close", () => {
    console.log("ℹ️ Twilio WS closed");
    try { oaWs.close(); } catch {}
  });
});

// =========================
// TWILIO VOICE WEBHOOK (NO SAY)
// =========================
app.post("/twilio/voice", (req, res) => {
  console.log("✅ Twilio hit /twilio/voice");

  const host = PUBLIC_BASE_URL || req.headers.host;

  res.type("text/xml");
  res.send(
    `
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>
    `.trim()
  );
});

// =========================
// START
// =========================
server.listen(PORT, () => {
  console.log("✅ Server running on port " + PORT);
});
