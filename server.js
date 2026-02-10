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

// TTS (definitivo)
const TTS_MODEL = (process.env.TTS_MODEL || "gpt-4o-mini-tts").trim(); // :contentReference[oaicite:1]{index=1}
const TTS_VOICE = (process.env.TTS_VOICE || "marin").trim();           // :contentReference[oaicite:2]{index=2}

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

// -------------------------
// G.711 u-law encoder (PCM16 -> uLaw)
// -------------------------
function linearToMuLawSample(sample) {
  // sample: int16
  const MU_LAW_MAX = 0x1FFF;
  const BIAS = 0x84;

  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > MU_LAW_MAX) sample = MU_LAW_MAX;

  sample = sample + BIAS;

  // exponent
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }
  let mantissa = (sample >> (exponent + 3)) & 0x0F;
  let muLawByte = ~(sign | (exponent << 4) | mantissa);
  return muLawByte & 0xFF;
}

function pcm24kToUlaw8kBase64(pcmBuf) {
  // pcmBuf = raw PCM16LE @ 24kHz (Audio API response_format="pcm") :contentReference[oaicite:3]{index=3}
  // Downsample 24k -> 8k (factor 3) simple decimation
  const int16 = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, Math.floor(pcmBuf.byteLength / 2));
  const outLen = Math.floor(int16.length / 3);
  const ulaw = Buffer.alloc(outLen);

  let j = 0;
  for (let i = 0; i < int16.length; i += 3) {
    ulaw[j++] = linearToMuLawSample(int16[i]);
  }
  return ulaw.toString("base64");
}

async function ttsToUlawChunks(text) {
  // 1) TTS -> PCM 24k (raw) :contentReference[oaicite:4]{index=4}
  const resp = await fetch("https://api.openai.com/v1/audio/speech", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: TTS_MODEL,
      voice: TTS_VOICE,
      input: text,
      response_format: "pcm", // raw 24kHz 16-bit LE :contentReference[oaicite:5]{index=5}
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => "");
    throw new Error(`TTS failed: ${resp.status} ${errText}`);
  }

  const pcmArrayBuf = await resp.arrayBuffer();
  const pcmBuf = Buffer.from(pcmArrayBuf);

  // 2) PCM24k -> uLaw8k base64
  const ulawBase64 = pcm24kToUlaw8kBase64(pcmBuf);

  // 3) Chunk para Twilio (20ms @ 8kHz uLaw = 160 bytes)
  const ulawRaw = Buffer.from(ulawBase64, "base64");
  const CHUNK_BYTES = 160; // 20ms
  const chunks = [];
  for (let i = 0; i < ulawRaw.length; i += CHUNK_BYTES) {
    chunks.push(ulawRaw.subarray(i, i + CHUNK_BYTES).toString("base64"));
  }
  return chunks;
}

function playChunksToTwilio(twilioWs, streamSid, chunks) {
  // Enviar 1 chunk cada 20ms para que suene en tiempo real
  let idx = 0;
  const interval = setInterval(() => {
    if (idx >= chunks.length) {
      clearInterval(interval);
      return;
    }
    if (twilioWs.readyState !== WebSocket.OPEN) {
      clearInterval(interval);
      return;
    }
    twilioWs.send(JSON.stringify({
      event: "media",
      streamSid,
      media: { payload: chunks[idx++] },
    }));
  }, 20);
}

wss.on("connection", (twilioWs) => {
  console.log("✅ Twilio connected to /media-stream");

  let streamSid = null;
  let greeted = false;
  let speaking = false;       // evita solaparse con TTS
  let lastAssistantText = ""; // buffer texto

  if (!OPENAI_API_KEY) {
    console.error("❌ Missing OPENAI_API_KEY");
    try { twilioWs.close(); } catch {}
    return;
  }

  const oaWs = new WebSocket(openaiWsUrl(REALTIME_MODEL), {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  oaWs.on("open", () => {
    console.log("✅ OpenAI Realtime connected");
    console.log("➡️ Sending session.update (text-only safe)");

    // ⚠️ SOLO CAMPOS QUE TU SERVIDOR ACEPTA (los que ya te funcionaban)
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

  // Twilio -> OpenAI
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

  // OpenAI -> Twilio (TEXT -> TTS -> AUDIO)
  oaWs.on("message", async (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }

    // Log tipo de evento (como ya vienes viendo)
    console.log("📩 OpenAI event:", evt.type);

    if (evt.type === "error") {
      console.error("❌ OpenAI event error:", evt.error);
      return;
    }

    // Saludo una sola vez: pedimos response.create (texto)
    if (evt.type === "session.updated" && !greeted) {
      greeted = true;
      oaWs.send(JSON.stringify({
        type: "response.create",
        response: {
          instructions: "Hello, this is Domotik Solutions. How can I help you today?"
        }
      }));
      return;
    }

    // Cuando el usuario habla, corta audio de Twilio si estamos reproduciendo
    if (evt.type === "input_audio_buffer.speech_started" && streamSid) {
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      return;
    }

    // Captura texto del modelo (puede llegar en distintos eventos)
    // 1) deltas de texto
    if (evt.type === "response.output_text.delta" && evt.delta) {
      lastAssistantText += evt.delta;
      return;
    }
    if (evt.type === "response.text.delta" && evt.delta) {
      lastAssistantText += evt.delta;
      return;
    }

    // 2) cuando termina la respuesta: convertimos texto a audio con TTS
    if (evt.type === "response.done") {
      const text = (lastAssistantText || "").trim();
      lastAssistantText = "";

      if (!text) {
        // Si tu backend no está mandando deltas, igual dejamos un log para ajustar si hace falta
        console.log("⚠️ response.done but no text captured (no output_text.delta received)");
        return;
      }

      // Evitar solape
      if (speaking) return;
      speaking = true;

      try {
        console.log("🗣️ TTS text:", text);
        const chunks = await ttsToUlawChunks(text);
        console.log("🔊 TTS chunks:", chunks.length);

        if (streamSid) playChunksToTwilio(twilioWs, streamSid, chunks);
      } catch (e) {
        console.error("❌ TTS error:", e?.message || e);
      } finally {
        // libera después de ~duración estimada (20ms por chunk)
        const ms = 20 *  (Math.max(1, Math.min(2000, (text.length * 6))) / 160);
        setTimeout(() => { speaking = false; }, Math.max(800, ms));
      }
      return;
    }
  });
});

// Twilio webhook (solo Stream)
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

server.listen(PORT, () => {
  console.log("✅ Server running on port " + PORT);
  console.log("ℹ️ PUBLIC_BASE_URL:", PUBLIC_BASE_URL || "(not set)");
  console.log("ℹ️ REALTIME_MODEL:", REALTIME_MODEL);
  console.log("ℹ️ TTS_MODEL:", TTS_MODEL);
  console.log("ℹ️ TTS_VOICE:", TTS_VOICE);
  console.log("ℹ️ OPENAI_API_KEY present:", OPENAI_API_KEY ? "YES" : "NO");
});
