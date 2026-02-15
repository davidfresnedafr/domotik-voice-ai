import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();

// ✅ MEJOR: en env. Ej: domotik-voice-ai.onrender.com (sin https)
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "domotik-voice-ai.onrender.com").trim();

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const MI_WHATSAPP = "whatsapp:+15617141075";
const TWILIO_WHATSAPP = "whatsapp:+14155238886";

const app = express();
app.use(express.urlencoded({ extended: false }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

/** ---------------------------
 * Helpers: Extractors
 * -------------------------- */
function extractPhone(text = "") {
  // Captura formatos: 561-714-1075, (561) 714-1075, 5617141075, +1 561...
  const m = text.match(/(\+?1[\s-]?)?(\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4})/);
  if (!m) return "";
  let p = (m[0] || "").replace(/[^\d+]/g, "");
  // normaliza a +1XXXXXXXXXX si viene US sin +
  if (/^\d{10}$/.test(p)) p = `+1${p}`;
  if (/^1\d{10}$/.test(p)) p = `+${p}`;
  return p;
}

function extractName(text = "") {
  // Ej: "My name is Jason", "I'm Jason", "This is Jason"
  const m = text.match(/\b(my name is|i'?m|this is)\s+([A-Za-z]{2,}(?:\s+[A-Za-z]{2,})?)\b/i);
  return m ? (m[2] || "").trim() : "";
}

function extractAddress(text = "") {
  // Muy básico: si contiene número + calle, o palabras tipo "Ave", "St", "Blvd", "Plaza", etc.
  const m = text.match(/\b\d{2,6}\s+[A-Za-z0-9.\s#-]{4,}\b(?:Street|St|Avenue|Ave|Blvd|Boulevard|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Way|Plaza|Pkwy|Parkway)\b/i);
  return m ? m[0].trim() : "";
}

function clean(s = "") {
  return (s || "").trim();
}

wss.on("connection", (twilioWs) => {
  let streamSid = null;
  let greeted = false;
  let fullTranscript = "";

  // ✅ Datos estructurados que SÍ quieres que lleguen por WhatsApp
  const lead = {
    name: "",
    phone: "",
    address: "",
    issue: ""
  };

  const oaWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1"
      }
    }
  );

  const sendGreeting = () => {
    if (!greeted && streamSid && oaWs.readyState === WebSocket.OPEN) {
      greeted = true;
      oaWs.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["audio", "text"],
          instructions:
            "Say ONLY: 'Thanks for calling Domotik Solutions. This is Elena. How can I help you today?'"
        }
      }));
    }
  };

  oaWs.on("open", () => {
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        instructions: `
Your name is Elena from Domotik Solutions.
BE VERY BRIEF.
MISSION: collect Name, Phone, Address, Issue.
If the user speaks, stop talking immediately.
English primarily. Spanish only if they speak it.

IMPORTANT:
- Always ask for phone if not provided.
- Always ask for full address (street + city) if not provided.
- After collecting details, confirm back in one sentence.
        `.trim(),
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 200,
          // ✅ 1 min 30 sec (90,000 ms) as you requested
          silence_duration_ms: 90000
        }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());

    // ✅ Interrupción: si el cliente habla, calla a Elena
    if (evt.type === "input_audio_buffer.speech_started") {
      if (streamSid) {
        twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
        oaWs.send(JSON.stringify({ type: "response.cancel" }));
      }
    }

    // ✅ Audio del bot hacia Twilio
    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({
        event: "media",
        streamSid,
        media: { payload: evt.delta }
      }));
    }

    // ✅ Transcript del BOT
    if (evt.type === "response.audio_transcript.done") {
      const t = clean(evt.transcript);
      if (t) fullTranscript += `E: ${t}\n`;
    }

    // ✅ Transcript del CLIENTE (aquí capturamos datos)
    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      const t = clean(evt.transcript);
      if (t) fullTranscript += `C: ${t}\n`;

      // Intento de extracción por regex
      if (!lead.phone) {
        const p = extractPhone(t);
        if (p) lead.phone = p;
      }
      if (!lead.name) {
        const n = extractName(t);
        if (n) lead.name = n;
      }
      if (!lead.address) {
        const a = extractAddress(t);
        if (a) lead.address = a;
      }

      // Issue: guarda la primera frase “útil” (si aún no hay)
      if (!lead.issue && t.length >= 8) {
        lead.issue = t;
      }
    }

    if (evt.type === "session.updated") {
      setTimeout(sendGreeting, 1200);
    }
  });

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") streamSid = msg.start.streamSid;

    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: msg.media.payload
      }));
    }
  });

  async function getStructuredSummaryFromOpenAI() {
    // Pedimos a OpenAI que extraiga campos, para rellenar lo que falte
    // OJO: Esto usa el mismo websocket realtime. Pedimos respuesta SOLO TEXTO para parsear.
    return new Promise((resolve) => {
      let got = false;
      const handler = (raw) => {
        try {
          const evt = JSON.parse(raw.toString());
          if (evt.type === "response.text.done" && evt.text && !got) {
            got = true;
            oaWs.off("message", handler);
            resolve(evt.text);
          }
        } catch {}
      };

      oaWs.on("message", handler);

      oaWs.send(JSON.stringify({
        type: "response.create",
        response: {
          modalities: ["text"],
          instructions: `
From this transcript, extract a JSON object with:
{name, phone, address, issue, callback_time}.
If unknown, use empty string.
Return ONLY valid JSON, no extra text.

TRANSCRIPT:
${fullTranscript.slice(-4000)}
          `.trim()
        }
      }));

      // Failsafe: si no contesta, resolvemos vacío
      setTimeout(() => {
        if (!got) {
          oaWs.off("message", handler);
          resolve("");
        }
      }, 6000);
    });
  }

  twilioWs.on("close", async () => {
    try {
      // ✅ 1) Completar faltantes con resumen estructurado
      let jsonText = "";
      if (oaWs.readyState === WebSocket.OPEN && fullTranscript.length > 30) {
        jsonText = await getStructuredSummaryFromOpenAI();
      }

      if (jsonText) {
        try {
          const parsed = JSON.parse(jsonText);
          lead.name = lead.name || clean(parsed.name);
          lead.phone = lead.phone || clean(parsed.phone);
          lead.address = lead.address || clean(parsed.address);
          lead.issue = lead.issue || clean(parsed.issue);
          lead.callback_time = clean(parsed.callback_time || "");
        } catch {
          // si JSON falla, no pasa nada
        }
      }

      // ✅ 2) Construir WhatsApp final CON DATOS
      const body =
        `🏠 *ORDEN DOMOTIK SOLUTIONS*\n\n` +
        `👤 *Nombre:* ${lead.name || "Not captured"}\n` +
        `📞 *Teléfono:* ${lead.phone || "Not captured"}\n` +
        `📍 *Dirección:* ${lead.address || "Not captured"}\n` +
        `🛠️ *Problema:* ${lead.issue || "Not captured"}\n` +
        (lead.callback_time ? `⏰ *Callback:* ${lead.callback_time}\n` : "") +
        `\n📋 *DETALLE COMPLETO:*\n${fullTranscript.slice(-1800)}`;

      if (fullTranscript.length > 10) {
        await client.messages.create({
          body,
          from: TWILIO_WHATSAPP,
          to: MI_WHATSAPP
        });
      }
    } catch (e) {
      console.error("Error WhatsApp:", e.message);
    }

    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(
    `<Response><Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect></Response>`
  );
});

server.listen(PORT, () => console.log(`🚀 Elena Ready`));
