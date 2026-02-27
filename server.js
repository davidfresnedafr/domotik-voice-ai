import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY   = (process.env.OPENAI_API_KEY || "").trim();
const PUBLIC_BASE_URL  = "domotik-voice-ai.onrender.com";

const client          = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const MI_WHATSAPP     = "whatsapp:+15617141075";
const TWILIO_WHATSAPP = "whatsapp:+14155238886";

const app = express();
app.use(express.urlencoded({ extended: false }));
const server = http.createServer(app);
const wss    = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/media-stream")) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

wss.on("connection", (twilioWs, req) => {
  const urlParams     = new URL(req.url, "http://localhost");
  let callerPhone     = urlParams.searchParams.get("caller") || null;
  let streamSid       = null;
  let callSid         = null;
  let fullTranscript  = [];
  let hangupScheduled = false;
  let bargeInTime     = 0;

  // Keepalive — prevents Render from closing idle WebSocket after 2 min
  const keepAlive = setInterval(() => {
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.ping();
    if (oaWs.readyState    === WebSocket.OPEN) oaWs.ping();
  }, 30000);

  const oaWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  oaWs.on("open", () => {
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
      timeZone: "America/New_York",
    });

    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `You are Elena, receptionist for Domotik Solutions LLC. Be warm and human. Keep responses to 1-2 sentences max.

TODAY IS: ${today}. Use real dates when scheduling (e.g. "Saturday March 8"), never "next Saturday".

LANGUAGE: Always greet in English. Then match customer language (English or Spanish) for the rest of the call.
NOISY CALL: Ask to repeat. After 2 failed attempts, offer callback, collect name + phone only, then say [HANGUP].

COLLECT IN THIS EXACT ORDER — confirm each step before moving to the next:
1. NAME — ask first. Do not continue without it.
2. SERVICE — ask "What exactly do you need?" Get specifics: type, quantity, location. Do not continue until specific.
3. ADDRESS — ask "What is the full address including city?" Do NOT move to step 4 without a real street address and city.
4. APPOINTMENT — ONLY after 1+2+3 confirmed. Mon-Fri 8am-6pm normal rate. Saturdays available with extra charge, warn before confirming. No Sundays. Confirm back the exact date and time.

ENDING THE CALL: Once all 4 steps are complete, give a brief summary and end with EXACTLY these words: "We will see you then. [HANGUP]"

RULES:
- NEVER assume or infer anything not clearly stated. If unclear, ask again.
- Never give prices for labor or products.
- Visit fee: $125 — becomes credit if they hire us.
- Services: security cameras, smart home, home theater, cabling, access control, alarms, intercoms, AV, electrical work, thermostat install, computer setup, printer install, IT support, network and WiFi setup.
- Only serves South Florida (Port St. Lucie to Florida Keys). If outside area, say so and say [HANGUP].
- Out of scope service → apologize and say [HANGUP].
- Customer says goodbye → short warm farewell → say [HANGUP].`,

        voice: "shimmer",
        speed: 1.15,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        max_response_output_tokens: 500,

        input_audio_transcription: {
          model: "whisper-1",
          prompt: "Phone call in English or Spanish. Transcribe only clear human speech. Return empty string for background noise.",
        },

        turn_detection: {
          type: "server_vad",
          threshold: 0.95,
          silence_duration_ms: 1200,
          prefix_padding_ms: 600,
        },
      },
    }));

    oaWs.send(JSON.stringify({
      type: "response.create",
      response: {
        instructions: `Say EXACTLY this in English, word for word:
"Thank you for calling Domotik Solutions LLC, your trusted home and building automation experts. My name is Elena, how can I help you today?"`,
      },
    }));
  });

  oaWs.on("message", (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }

    // Elena audio → Twilio
    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    // Barge-in — customer speaks → Elena stops immediately
    if (evt.type === "input_audio_buffer.speech_started" && streamSid) {
      bargeInTime = Date.now();
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      oaWs.send(JSON.stringify({ type: "response.cancel" }));
    }

    // Customer transcript
    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      const text = (evt.transcript || "").trim();

      // Ignore noise/hallucinations
      if (text.length < 3 || /^[^a-zA-ZáéíóúÁÉÍÓÚñÑ]+$/.test(text)) {
        console.log(`🔇 Ruido ignorado: "${text}"`);
        return;
      }

      fullTranscript.push(`Cliente: ${text}`);
      console.log(`👤 Cliente: ${text}`);

      const t = text.toLowerCase();
      const goodbyes = ["bye", "goodbye", "good bye", "adios", "adiós",
                        "hasta luego", "chao", "chau", "nos vemos",
                        "gracias adios", "gracias adiós"];
      if (goodbyes.some(w => t.includes(w)) && !hangupScheduled) {
        console.log("👋 Cliente se despidió — colgando en 6s");
        scheduleHangup(6000);
      }
    }

    // Elena transcript — ONLY [HANGUP] triggers hangup (no other phrases)
    if (evt.type === "response.audio_transcript.done") {
      const text = evt.transcript || "";
      fullTranscript.push(`Elena: ${text}`);
      console.log(`🤖 Elena: ${text}`);

      if (text.includes("[HANGUP]") && !hangupScheduled) {
        console.log("📴 [HANGUP] detectado — colgando en 5s");
        scheduleHangup(5000);
      }
    }

    if (evt.type === "error") console.error("❌ OpenAI error:", JSON.stringify(evt.error));
  });

  twilioWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      callSid   = msg.start.callSid;
      console.log(`📞 Llamada | callSid: ${callSid} | caller: ${callerPhone}`);

      if (!callerPhone || callerPhone === "unknown") {
        client.calls(callSid).fetch()
          .then(call => { callerPhone = call.from; console.log(`📱 Caller: ${callerPhone}`); })
          .catch(e => console.error("❌ Caller error:", e));
      }
    }

    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", async () => {
    clearInterval(keepAlive);
    console.log("🔴 Llamada cerrada. Procesando reporte...");
    await new Promise(r => setTimeout(r, 3000));

    if (fullTranscript.length === 0) {
      console.log("⚠️ Transcript vacío — no se envía reporte");
      return;
    }

    const chat = fullTranscript.join("\n");
    console.log("📋 Transcript:\n" + chat);

    // Extract with GPT
    let info = { name: "Not provided", phone: "Not provided", address: "Not provided", service: "Not provided", appointment: "Not provided" };
    try {
      const gptRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `Extract from this call transcript:
- name: full name of the customer
- phone: phone number the customer mentioned
- address: FULL address — number, street, city, state. Search carefully, may be given in parts. Include apartment/unit/zip if mentioned.
- service: what the CUSTOMER (lines labeled "Cliente:") said they need. All specifics. Never use Elena's words.
- appointment: exact confirmed date and time (e.g. "Saturday March 8 at 10 AM"). Never just "next Saturday".
Return ONLY valid JSON: { "name": "", "phone": "", "address": "", "service": "", "appointment": "" }
Use "Not provided" for missing fields.`,
            },
            { role: "user", content: chat },
          ],
          response_format: { type: "json_object" },
        }),
      });
      const gptJson = await gptRes.json();
      info = JSON.parse(gptJson.choices[0].message.content);
      console.log("📊 Datos extraídos:", info);
    } catch (e) {
      console.error("❌ GPT error:", e.message);
    }

    const phoneToShow = (info.phone && info.phone !== "Not provided")
      ? info.phone : (callerPhone || "Not provided");

    const body =
      `🚀 *ORDEN TÉCNICA DOMOTIK*\n\n` +
      `👤 *NOMBRE:* ${(info.name || "Not provided").toUpperCase()}\n` +
      `📞 *TEL:* ${phoneToShow}\n` +
      `📍 *DIR:* ${info.address || "Not provided"}\n` +
      `🔧 *SERVICIO:* ${info.service || "Not provided"}\n` +
      `📅 *CITA:* ${info.appointment || "No agendada"}`;

    // Send WhatsApp — retry once on failure
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await client.messages.create({ body, from: TWILIO_WHATSAPP, to: MI_WHATSAPP });
        console.log(`✅ WhatsApp enviado (intento ${attempt})`);
        break;
      } catch (err) {
        console.error(`❌ WhatsApp intento ${attempt}:`, err.message);
        if (attempt === 2) {
          const fs = await import("fs");
          fs.default.appendFileSync("missed_reports.json",
            JSON.stringify({ timestamp: new Date().toISOString(), caller: callerPhone, data: info, transcript: chat }) + "\n"
          );
          console.log("💾 Guardado en missed_reports.json");
        }
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  });

  oaWs.on("error",    e => console.error("OpenAI WS error:", e));
  twilioWs.on("error", e => console.error("Twilio WS error:", e));

  function scheduleHangup(delayMs) {
    if (hangupScheduled) return;
    hangupScheduled = true;
    setTimeout(() => {
      if (callSid) client.calls(callSid).update({ status: "completed" }).catch(console.error);
      twilioWs.close();
    }, delayMs);
  }
});

app.post("/twilio/voice", (req, res) => {
  const callerNumber = req.body?.From || "unknown";
  console.log(`📲 Llamada entrante: ${callerNumber}`);
  res.type("text/xml").send(
    `<Response><Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream?caller=${encodeURIComponent(callerNumber)}" /></Connect></Response>`
  );
});

server.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Domotik Voice AI corriendo en puerto ${PORT}`)
);

server.keepAliveTimeout = 620000;
server.headersTimeout   = 630000;
