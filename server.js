import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

// =========================
// CONFIG
// =========================
const PORT = process.env.PORT || 3000;

// Render env (tu screenshot tenía PUBLIC_BASE_URL)
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || process.env.PUBLIC_BASE_URL?.trim();

// OpenAI env
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim(); // ✅ TRIM evita espacios/saltos de línea
const REALTIME_MODEL = (process.env.REALTIME_MODEL || "gpt-realtime").trim();

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

  // ✅ Validación para no crashear
  if (!OPENAI_API_KEY) {
    console.error("❌ Missing OPENAI_API_KEY in Render Environment Variables");
    // Cerramos el stream para que no quede colgado
    try { twilioWs.close(); } catch {}
    return;
  }

  // -------------------------
  // OpenAI Realtime WS
  // -------------------------
  const oaWs = new WebSocket(openaiWsUrl(REALTIME_MODEL), {
    headers: {
      // ✅ AQUÍ ESTÁ EL CAMBIO CLAVE:
      // si la key tenía un salto de línea/espacio invisible, esto lo limpia
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  oaWs.on("open", () => {
    console.log("✅ OpenAI Realtime connected");

    // Configuración de sesión (audio fluido, barge-in, bilingüe)
    oaWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          instructions: `
You are the Domotik Solutions voice assistant.
You handle CCTV, access control, networking and smart home services.
If the caller speaks Spanish, respond in Spanish.
Be concise and professional.
If the caller asks for a human or it’s urgent, say you will transfer.
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
      })
    );

    // ✅ La IA habla primero (para evitar silencio)
    oaWs.send(
      JSON.stringify({
        type: "response.create",
        response: {
          instructions:
            "Hello, this is Domotik Solutions. How can I help you today?",
        },
      })
    );
  });

  oaWs.on("error", (err) => {
    console.error("❌ OpenAI WS error:", err);
  });

  oaWs.on("close", (code, reason) => {
    console.log("ℹ️ OpenAI WS closed:", code, reason?.toString?.() || "");
  });

  // -------------------------
  // Twilio → OpenAI (audio)
  // -------------------------
  twilioWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      console.log("📞 Stream started:", streamSid);
      return;
    }

    if (msg.event === "media" && msg.media?.payload) {
      if (oaWs.readyState === WebSocket.OPEN) {
        oaWs.send(
          JSON.stringify({
            type: "input_audio_buffer.append",
            audio: msg.media.payload, // base64 g711_ulaw
          })
        );
      }
      return;
    }

    if (msg.event === "stop") {
      console.log("🛑 Stream stopped");
      try { oaWs.close(); } catch {}
      return;
    }

    if (msg.event === "mark") {
      // opcional
      return;
    }
  });

  twilioWs.on("close", () => {
    console.log("ℹ️ Twilio WS closed");
    try { oaWs.close(); } catch {}
  });

  twilioWs.on("error", (err) => {
    console.error("❌ Twilio WS error:", err);
    try { oaWs.close(); } catch {}
  });

  // -------------------------
  // OpenAI → Twilio (audio)
  // -------------------------
  oaWs.on("message", (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw.toString());
    } catch (e) {
      return;
    }

    // Interrupción (barge-in)
    if (evt.type === "input_audio_buffer.speech_started" && streamSid) {
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      return;
    }

    // Audio de la IA hacia la llamada
    if (
      (evt.type === "response.audio.delta" ||
        evt.type === "response.output_audio.delta") &&
      evt.delta &&
      streamSid
    ) {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: evt.delta }, // base64 g711_ulaw
        })
      );
      return;
    }

    // Errores del API
    if (evt.type === "error") {
      console.error("❌ OpenAI event error:", evt.error);
    }
  });
});

// =========================
// TWILIO VOICE WEBHOOK (NO SAY)
// =========================
app.post("/twilio/voice", (req, res) => {
  console.log("✅ Twilio hit /twilio/voice");

  const host = (process.env.PUBLIC_BASE_URL || req.headers.host || "").trim();

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
  console.log("ℹ️ PUBLIC_BASE_URL:", (process.env.PUBLIC_BASE_URL || "").trim());
  console.log("ℹ️ REALTIME_MODEL:", REALTIME_MODEL);
  console.log("ℹ️ OPENAI_API_KEY present:", OPENAI_API_KEY ? "YES" : "NO");
});
