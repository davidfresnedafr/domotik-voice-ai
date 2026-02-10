import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

// =========================
// CONFIGURACIÓN
// =========================
const PORT = process.env.PORT || 3000;
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim();
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const REALTIME_MODEL = (process.env.REALTIME_MODEL || "gpt-4o-realtime-preview").trim();

// Para el endpoint /v1/audio/speech usamos tts-1
const TTS_MODEL = "tts-1"; 
const TTS_VOICE = "alloy"; // Opciones: alloy, echo, fable, onyx, nova, shimmer

const app = express();
app.use(express.urlencoded({ extended: false }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

// =========================
// UTILIDADES DE AUDIO (PCM -> uLaw)
// =========================

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

  if (!resp.ok) throw new Error(`TTS API Error: ${resp.status}`);

  const pcmBuf = Buffer.from(await resp.arrayBuffer());
  const ulawBase64 = pcm24kToUlaw8kBase64(pcmBuf);
  const ulawRaw = Buffer.from(ulawBase64, "base64");
  
  const CHUNK_SIZE = 160; 
  const chunks = [];
  for (let i = 0; i < ulawRaw.length; i += CHUNK_SIZE) {
    chunks.push(ulawRaw.subarray(i, i + CHUNK_SIZE).toString("base64"));
  }
  return chunks;
}

// =========================
// LÓGICA DEL WEBSOCKET
// =========================

wss.on("connection", (twilioWs) => {
  console.log("✅ Twilio conectado");

  let streamSid = null;
  let greeted = false;
  let speaking = false; // Bloqueo de interrupción
  let lastAssistantText = "";

  const oaWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`, {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  oaWs.on("open", () => {
    console.log("✅ OpenAI conectado");
    // Configuración de sesión optimizada
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        instructions: "Eres un asistente de Domotik Solutions. Sé breve y responde en español.",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        modalities: ["text"], // Forzamos solo texto para evitar conflictos de audio binario
        turn_detection: { 
          type: "server_vad",
          threshold: 0.6 // Evita disparos por ruido de fondo
        },
      },
    }));
  });

  // Twilio -> OpenAI (Entrada de audio)
  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
    } else if (msg.event === "media") {
      // CRÍTICO: Si el bot está hablando, no enviamos el audio a OpenAI 
      // para que no se interrumpa a sí mismo (eco).
      if (oaWs.readyState === WebSocket.OPEN && !speaking) {
        oaWs.send(JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload,
        }));
      }
    }
  });

  // OpenAI -> Twilio (Procesamiento de respuesta)
  oaWs.on("message", async (raw) => {
    const evt = JSON.parse(raw.toString());
    
    // Saludo inicial al conectar
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
      return;
    }

    // Captura de texto acumulado
    if (evt.type === "response.text.delta" || evt.type === "response.output_text.delta") {
      lastAssistantText += evt.delta;
    }

    // Cuando OpenAI termina de escribir, convertimos a audio
    if (evt.type === "response.done") {
      const text = (evt.response?.output?.[0]?.content?.[0]?.text || lastAssistantText).trim();
      lastAssistantText = "";

      if (text) {
        speaking = true; // Bloqueamos el micrófono mientras habla el bot
        console.log("🗣️ Asistente dice:", text);

        try {
          const chunks = await ttsToUlawChunks(text);
          
          // Enviamos chunks a Twilio con timing de 20ms
          let i = 0;
          const interval = setInterval(() => {
            if (i >= chunks.length || twilioWs.readyState !== WebSocket.OPEN) {
              clearInterval(interval);
              // Damos un pequeño margen antes de reabrir el micrófono
              setTimeout(() => { speaking = false; }, 500); 
              return;
            }
            twilioWs.send(JSON.stringify({
              event: "media",
              streamSid,
              media: { payload: chunks[i++] },
            }));
          }, 20);

        } catch (e) {
          console.error("❌ Error TTS:", e.message);
          speaking = false;
        }
      }
    }
  });

  twilioWs.on("close", () => oaWs.close());
});

// Webhook inicial de Twilio
app.post("/twilio/voice", (req, res) => {
  const host = (PUBLIC_BASE_URL || req.headers.host).trim();
  res.type("text/xml").send(`
    <Response>
      <Connect><Stream url="wss://${host}/media-stream" /></Connect>
    </Response>
  `);
});

server.listen(PORT, () => console.log(`🚀 Servidor listo en puerto ${PORT}`));
