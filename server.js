import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();

// ✅ PONLO EN ENV (Render): domotik-voice-ai.onrender.com
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim();

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const MI_WHATSAPP = "whatsapp:+15617141075";
const TWILIO_WHATSAPP = "whatsapp:+14155238886";

const app = express();
app.use(express.urlencoded({ extended: false }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

/* -----------------------
   Helpers (extractors)
------------------------ */
function clean(s = "") {
  return (s || "").trim();
}

function saidBye(text = "") {
  const t = (text || "").toLowerCase();
  return /\b(bye|goodbye|adios|adiós|chao|ciao|see you|thanks bye|thank you bye)\b/.test(t);
}

function extractPhone(text = "") {
  // US formats: (561) 714-1075 | 561-714-1075 | 5617141075 | +1 561...
  const m = text.match(/(\+?1[\s-]?)?(\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4})/);
  if (!m) return "";
  let p = (m[0] || "").replace(/[^\d+]/g, "");
  if (/^\d{10}$/.test(p)) p = `+1${p}`;
  if (/^1\d{10}$/.test(p)) p = `+${p}`;
  return p;
}

function extractName(text = "") {
  const m = text.match(/\b(my name is|i'?m|this is)\s+([A-Za-z]{2,}(?:\s+[A-Za-z]{2,})?)\b/i);
  return m ? clean(m[2]) : "";
}

function extractAddress(text = "") {
  // street pattern
  const street = text.match(
    /\b\d{2,6}\s+[A-Za-z0-9.\s#-]{4,}\b(?:Street|St|Avenue|Ave|Blvd|Boulevard|Rd|Road|Dr|Drive|Ln|Lane|Ct|Court|Way|Pkwy|Parkway)\b/i
  );
  if (street) return clean(street[0]);

  // place fallback: "Parker Plaza in Hallandale"
  const place = text.match(/\b([A-Za-z][A-Za-z\s]{2,})\s+(plaza|tower|building|office)\b.*\b(in|at)\s+([A-Za-z\s]{3,})\b/i);
  if (place) return clean(place[0]);

  return "";
}

function extractCallback(text = "") {
  // simple patterns like "tomorrow morning", "today after 5", "at 3pm"
  const m = text.match(/\b(today|tomorrow|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b.*\b(\d{1,2}(:\d{2})?\s?(am|pm)?)\b/i)
        || text.match(/\b(after\s+\d{1,2}\s?(am|pm)|morning|afternoon|evening|anytime after \d{1,2})\b/i);
  return m ? clean(m[0]) : "";
}

/* -----------------------
   WebSocket: Twilio <-> OpenAI
------------------------ */
wss.on("connection", (twilioWs) => {
  console.log("📞 Nueva llamada conectada");

  let streamSid = null;
  let ended = false;
  let greeted = false;

  let fullTranscript = ""; // texto completo para resumen final
  const lead = { name: "", phone: "", address: "", issue: "", callback_time: "" };

  const oaWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  const endStream = () => {
    if (ended) return;
    ended = true;
    try { twilioWs.close(); } catch {}
    try { if (oaWs.readyState === WebSocket.OPEN) oaWs.close(); } catch {}
  };

  function mergeLead(parsed = {}) {
    lead.name = lead.name || clean(parsed.name);
    lead.phone = lead.phone || clean(parsed.phone);
    lead.address = lead.address || clean(parsed.address);
    lead.issue = lead.issue || clean(parsed.issue);
    lead.callback_time = lead.callback_time || clean(parsed.callback_time);
  }

  function requestJsonExtraction() {
    // Usamos Realtime para pedir un JSON final con los campos
    return new Promise((resolve) => {
      let done = false;

      const handler = (raw) => {
        try {
          const evt = JSON.parse(raw.toString());
          if (evt.type === "response.text.done" && evt.text && !done) {
            done = true;
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
Extract a JSON object from this transcript with:
{name, phone, address, issue, callback_time}
If unknown use "".
Return ONLY valid JSON (no extra words).

TRANSCRIPT:
${fullTranscript.slice(-4500)}
          `.trim()
        }
      }));

      setTimeout(() => {
        if (!done) {
          oaWs.off("message", handler);
          resolve("");
        }
      }, 6000);
    });
  }

  function sendGreetingOnce() {
    if (greeted) return;
    if (!streamSid) return;
    if (oaWs.readyState !== WebSocket.OPEN) return;

    greeted = true;
    oaWs.send(JSON.stringify({
      type: "response.create",
      response: {
        modalities: ["audio", "text"],
        instructions: `Say only: "Hi! I'm Elena from Domotik Solutions. How can I help you today?"`
      }
    }));
  }

  oaWs.on("open", () => {
    console.log("🟢 OpenAI Realtime listo");

    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: {
          type: "server_vad",
          threshold: 0.5,
          prefix_padding_ms: 200,
          // ✅ 1 minuto y medio
          silence_duration_ms: 90000
        },
        instructions: `
Your name is Elena from Domotik Solutions.

RULES:
- Be BRIEF (under 12 words).
- Collect: Name, Phone, Address, Issue, Preferred callback time.
- If caller says Bye/Adios, say: "Thanks! Goodbye." then STOP.
- If phone not captured, ask: "Please say each digit slowly."
- No prices: "A technician will quote after the visit."
- English primarily. Spanish only if caller speaks Spanish.
        `.trim()
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());

    // ✅ Si el usuario habla, cortamos audio del bot inmediatamente
    if (evt.type === "input_audio_buffer.speech_started" && streamSid) {
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      oaWs.send(JSON.stringify({ type: "response.cancel" }));
    }

    // ✅ Audio del bot -> Twilio
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
      if (t) fullTranscript += `Elena: ${t}\n`;
    }

    // ✅ Transcript del CLIENTE (aquí capturamos datos)
    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      const t = clean(evt.transcript);
      if (t) fullTranscript += `Cliente: ${t}\n`;

      // Detectar bye/adios y colgar
      if (saidBye(t)) {
        // opcional: Elena se despide breve
        if (oaWs.readyState === WebSocket.OPEN) {
          oaWs.send(JSON.stringify({
            type: "response.create",
            response: { modalities: ["audio", "text"], instructions: `Say only: "Thanks! Goodbye."` }
          }));
        }
        setTimeout(endStream, 1200);
        return;
      }

      // Extraer campos (regex)
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
      if (!lead.callback_time) {
        const c = extractCallback(t);
        if (c) lead.callback_time = c;
      }

      // Issue: guarda la primera frase “útil” si no existe aún
      if (!lead.issue && t.length >= 10) {
        lead.issue = t;
      }
    }
  });

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      // ✅ Saludo 1 vez cuando Twilio ya está listo
      setTimeout(sendGreetingOnce, 600);
    }

    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: msg.media.payload
      }));
    }
  });

  twilioWs.on("close", async () => {
    try {
      // ✅ Completar faltantes con extracción JSON final
      let jsonText = "";
      if (oaWs.readyState === WebSocket.OPEN && fullTranscript.length > 30) {
        jsonText = await requestJsonExtraction();
      }

      if (jsonText) {
        try {
          mergeLead(JSON.parse(jsonText));
        } catch {}
      }

      // ✅ WhatsApp con datos (no solo transcript)
      const body =
        `🏠 *ORDEN DOMOTIK SOLUTIONS*\n\n` +
        `👤 *Nombre:* ${lead.name || "Not captured"}\n` +
        `📞 *Teléfono:* ${lead.phone || "Not captured"}\n` +
        `📍 *Dirección:* ${lead.address || "Not captured"}\n` +
        `🛠️ *Problema:* ${lead.issue || "Not captured"}\n` +
        (lead.callback_time ? `⏰ *Callback:* ${lead.callback_time}\n` : "") +
        `\n📋 *DETALLE (último):*\n${fullTranscript.slice(-1500)}`;

      if (fullTranscript.length > 10) {
        await client.messages.create({
          body,
          from: TWILIO_WHATSAPP,
          to: MI_WHATSAPP
        });
      }
    } catch (e) {
      console.error("WhatsApp Error:", e.message);
    }

    try { if (oaWs.readyState === WebSocket.OPEN) oaWs.close(); } catch {}
  });
});

/* -----------------------
   Twilio Voice Webhook
   ✅ Sin "Connecting..." y con Hangup final
------------------------ */
app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`
<Response>
  <Connect>
    <Stream url="wss://${PUBLIC_BASE_URL}/media-stream" />
  </Connect>
  <Hangup/>
</Response>
  `.trim());
});

// ✅ Render fix
server.listen(PORT, "0.0.0.0", () => {
  console.log(`🚀 Elena ONLINE on Port ${PORT}`);
});
