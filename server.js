import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

// =========================
// CONFIG
// =========================
const PORT = process.env.PORT || 3000;

const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const REALTIME_MODEL = (process.env.REALTIME_MODEL || "gpt-4o-realtime-preview").trim();

// TTS: El endpoint /v1/audio/speech requiere modelos tts-1 o tts-1-hd
const TTS_MODEL = "tts-1"; 
const TTS_VOICE = (process.env.TTS_VOICE || "alloy").trim(); // Voces: alloy, echo, fable, onyx, nova, shimmer

// =========================
// APP & SERVER
// =========================
const app = express();
app.use(express.urlencoded({ extended: false }));

app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/healthz", (_req, res) => res.status(200).send("OK"));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

// =========================
// HELPERS
// =========================

function openaiWsUrl(model) {
  return `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
}

// Codificador G.711 u-law (Necesario para Twilio)
function linearToMuLawSample(sample) {
  const MU_LAW_MAX = 0x1FFF;
  const BIAS = 0x84;
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > MU_LAW_MAX) sample = MU_LAW_MAX;
  sample = sample + BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) {
    exponent--;
  }
  let mantissa = (sample >> (exponent + 3)) & 0x0F;
  let muLawByte = ~(sign | (exponent << 4) | mantissa);
  return muLawByte & 0xFF;
}

function pcm24kToUlaw8kBase64(pcmBuf) {
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
      response_format: "pcm", 
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`TTS failed: ${resp.status} ${errText}`);
  }

  const pcmArrayBuf = await resp.arrayBuffer();
  const pcmBuf = Buffer.from(pcmArrayBuf);
  const ulawBase64 = pcm24kToUlaw8kBase64(pcmBuf);
  const ulawRaw = Buffer.from(ulawBase64, "base64");
  
  const CHUNK_BYTES = 160; // 20ms de audio
  const chunks = [];
  for (let i = 0; i < ulawRaw.length; i += CHUNK_BYTES) {
    chunks.push(ulawRaw.subarray(i, i + CHUNK_BYTES).toString("base64"));
  }
  return chunks;
}

function playChunksToTwilio(twilioWs, streamSid, chunks) {
  let idx = 0;
  const interval = setInterval(() => {
    if (idx >= chunks.length || twilioWs.readyState !== WebSocket.OPEN) {
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

// =========================
// WEBSOCKET LOGIC
// =========================

wss.on("connection", (twilioWs) => {
  console.log("✅ Twilio connected");

  let streamSid = null;
  let greeted = false;
  let speaking = false;
  let lastAssistantText = "";

  const oaWs = new WebSocket(openaiWsUrl(REALTIME_MODEL), {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  oaWs.on("open", () => {
    console.log("✅ OpenAI Realtime connected");
    // Configuración inicial de la sesión
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: "You are the Domotik Solutions assistant. Professional and concise. Speak Spanish if the user does.",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad" },
      },
    }));
  });

  // Twilio -> OpenAI
  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      console.log("📞 Stream started:", streamSid);
    } else if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: msg.media.payload,
      }));
    }
  });

  // OpenAI -> Twilio
  oaWs.on("message", async (raw) => {
    const evt = JSON.parse(raw.toString());
    console.log("📩 Event:", evt.type);

    if (evt.type === "error") {
      console.error("❌ OpenAI Error:", evt.error);
      return;
    }

    // SALUDO INICIAL (Solución al error session.type)
    if (evt.type === "session.updated" && !greeted) {
      greeted = true;
      oaWs.send(JSON.stringify({
        type: "conversation.item.create",
        item: {
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "Hola, bienvenido a Domotik Solutions. ¿En qué puedo ayudarte?" }]
        }
      }));
      oaWs.send(JSON.stringify({ type: "response.create" }));
    }

    // Interrupción por voz del usuario
    if (evt.type === "input_audio_buffer.speech_started" && streamSid) {
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
    }

    // Acumular texto
    if (evt.type === "response.text.delta" || evt.type === "response.output_text.delta") {
      lastAssistantText += evt.delta;
    }

    // Procesar respuesta completa con TTS externo
    if (evt.type === "response.done") {
      const text = (evt.response?.output?.[0]?.content?.[0]?.text || lastAssistantText).trim();
      lastAssistantText = "";

      if (text && !speaking) {
        speaking = true;
        try {
          console.log("🗣️ TTS:", text);
          const chunks = await ttsToUlawChunks(text);
          if (streamSid) playChunksToTwilio(twilioWs, streamSid, chunks);
        } catch (e) {
          console.error("❌ TTS Error:", e.message);
        } finally {
          setTimeout(() => { speaking = false; }, 1000);
        }
      }
    }
  });

  twilioWs.on("close", () => oaWs.close());
  oaWs.on("close", () => console.log("ℹ️ OpenAI closed"));
});

// Webhook para Twilio
app.post("/twilio/voice", (req, res) => {
  const host = (PUBLIC_BASE_URL || req.headers.host).trim();
  res.type("text/xml").send(`
    <Response>
      <Connect><Stream url="wss://${host}/media-stream" /></Connect>
    </Response>
  `);
});

server.listen(PORT, () => console.log(`🚀 Server on port ${PORT}`));
