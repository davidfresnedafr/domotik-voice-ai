import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

// =========================
// CONFIG
// =========================
const PORT = process.env.PORT || 3000;

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const REALTIME_MODEL = (process.env.REALTIME_MODEL || "gpt-realtime").trim();

// =========================
// APP
// =========================
const app = express();
app.use(express.urlencoded({ extended: false }));

app.use((req, _res, next) => {
  console.log(`➡️ ${req.method} ${req.path}`);
  next();
});

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
  let greeted = false;

  if (!OPENAI_API_KEY) {
    console.error("❌ Missing OPENAI_API_KEY in Render Environment Variables");
    try { twilioWs.close(); } catch {}
    return;
  }

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
    console.log("➡️ Sending session.update (stable)");

    // ✅ Session.update estable (SIN modalities, SIN output, SIN audio)
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: `
You are the Domotik Solutions voice assistant.
You handle CCTV, access control, networking and smart home services.
If the caller speaks Spanish, respond in Spanish.
Be concise and professional.
        `.trim(),

        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        voice: "marin",

        turn_detection: {
          type: "server_vad",
          create_response: true,
          interrupt_response: true,
        },
      },
    }));
  });

  oaWs.on("error", (err) => console.error("❌ OpenAI WS error:", err));
  oaWs.on("close", (code, reason) =>
    console.log("ℹ️ OpenAI WS closed:", code, reason?.toString?.() || "")
  );

  // -------------------------
  // Twilio → OpenAI (audio)
  // -------------------------
  twilioWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start?.streamSid || null;
      console.log("📞 Stream started:", streamSid);
      return;
    }

    if (msg.event === "media" && msg.media?.payload) {
      if (oaWs.readyState === WebSocket.OPEN) {
        oaWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload,
        }));
      }
      return;
    }

    if (msg.event === "stop") {
      console.log("🛑 Stream stopped");
      try { oaWs.close(); } catch {}
      return;
    }
  });

  twilioWs.on("close", () => {
    console.log("ℹ️ Twilio WS closed");
    try { oaWs.close(); } catch {}
  });

  // -------------------------
  // OpenAI → Twilio (audio)
  // -------------------------
  oaWs.on("message", (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }

    console.log("📩 OpenAI event:", evt.type);

    if (evt.type === "error") {
      console.error("❌ OpenAI event error:", evt.error);
      return;
    }

    // ✅ Cuando quede aplicada la sesión, pedimos un saludo FORZANDO AUDIO
    if (evt.type === "session.updated" && !greeted) {
      greeted = true;
      console.log("✅ Session updated, requesting greeting audio...");

      oaWs.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio"],
          voice: "marin",
          output_audio_format: "g711_ulaw",
          instructions: "Hello, this is Domotik Solutions. How can I help you today?"
        }
      }));
      return;
    }

    // barge-in: si el usuario habla, corta audio en Twilio
    if ((evt.type === "input_audio_buffer.speech_started" || evt.type === "input_audio_buffer.speech_started") && streamSid) {
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      return;
    }

    // ✅ AUDIO DEL MODELO → TWILIO (soporta varios nombres)
    const audioDelta =
      (evt.type === "response.output_audio.delta" && evt.delta) ? evt.delta :
      (evt.type === "response.audio.delta" && evt.delta) ? evt.delta :
      (evt.type === "output_audio.delta" && evt.delta) ? evt.delta :
      null;

    if (audioDelta && streamSid) {
      console.log("🔊 audio delta bytes:", audioDelta.length);
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: audioDelta },
      }));
      return;
    }
  });
});

// =========================
// TWILIO VOICE WEBHOOK (NO SAY)
// =========================
app.post("/twilio/voice", (req, res) => {
  console.log("✅ Twilio hit /twilio/voice");
  const host = (PUBLIC_BASE_URL || req.headers.host || "").trim();

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
  console.log("ℹ️ PUBLIC_BASE_URL:", PUBLIC_BASE_URL || "(not set)");
  console.log("ℹ️ REALTIME_MODEL:", REALTIME_MODEL);
  console.log("ℹ️ OPENAI_API_KEY present:", OPENAI_API_KEY ? "YES" : "NO");
});
