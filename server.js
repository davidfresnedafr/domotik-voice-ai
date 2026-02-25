import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const PUBLIC_BASE_URL = "domotik-voice-ai.onrender.com";

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const MI_WHATSAPP   = "whatsapp:+15617141075";
const TWILIO_WHATSAPP = "whatsapp:+14155238886";

const app = express();
app.use(express.urlencoded({ extended: false }));
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/media-stream")) {
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  } else {
    socket.destroy();
  }
});

wss.on("connection", (twilioWs, req) => {
  const urlParams = new URL(req.url, "http://localhost");
  let callerPhone   = urlParams.searchParams.get("caller") || null;
  let streamSid     = null;
  let callSid       = null;
  let fullTranscript = [];
  let hangupScheduled = false;
  let bargeInTime = 0;

  // ── OpenAI Realtime ────────────────────────────────────────
  const oaWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" } }
  );

  oaWs.on("open", () => {
    // Get today's date to inject into prompt
    const today = new Date().toLocaleDateString("en-US", {
      weekday: "long", year: "numeric", month: "long", day: "numeric",
      timeZone: "America/New_York"
    });

    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `You are Elena, receptionist for Domotik Solutions LLC. Be warm and human. Keep responses to 1-2 sentences max.

TODAY IS: ${today}. Use this when scheduling appointments — always give the actual date (e.g. "Saturday March 8") not just "next Saturday".

LANGUAGE: First message always in English. Then match customer's language (English or Spanish) for rest of call. Never switch.
NOISY CALL: If you can't understand, ask to repeat. After 2 tries, offer callback, collect name + phone only, then [HANGUP].

COLLECT IN THIS EXACT ORDER — confirm each before moving to next:
1. NAME — ask first. Do not continue without it.
2. SERVICE — ask "What exactly do you need?" Get specifics: type, quantity, location. Do not continue until specific.
3. ADDRESS — ask "What is the full address including city?" REQUIRED before scheduling. If they skip it, ask again. Do NOT move to step 4 without a real street address.
4. APPOINTMENT — ask day and time ONLY after 1+2+3 confirmed. Mon-Fri 8am-6pm normal rate. Saturdays with extra charge. No Sundays. Confirm back the exact date and time.

RULES:
- Never give prices for labor or products.
- Visit fee: $125 — becomes credit if they hire us.
- Services: security cameras, smart home, home theater, cabling, access control, alarms, intercoms, AV, electrical work, thermostat install, computer installation and setup, printer installation and network setup, IT support, network and WiFi setup.
- Only serves South Florida (Port St. Lucie to Florida Keys). If outside area → say so and [HANGUP].
- Out of scope service → apologize and [HANGUP].
- When customer says goodbye → short farewell → [HANGUP].`,

        voice: "shimmer",
        speed: 1.15,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        max_response_output_tokens: 500,

        // ✅ Transcription explicitly enabled — required for transcript events
        input_audio_transcription: {
          model: "whisper-1",
        },

        // ✅ NO barge-in — noise/clicks/vibration will never interrupt Elena
        turn_detection: {
          type: "server_vad",
          threshold: 0.9,
          silence_duration_ms: 1500, // more patience before responding
          prefix_padding_ms: 500,
        },
      },
    }));

    // Force exact English greeting
    oaWs.send(JSON.stringify({
      type: "response.create",
      response: {
        instructions: `Say EXACTLY this in English, word for word, no changes:
"Thank you for calling Domotik Solutions LLC, your trusted home and building automation experts. My name is Elena, how can I help you today?"`,
      },
    }));
  });

  // ── OpenAI messages ────────────────────────────────────────
  oaWs.on("message", (raw) => {
    let evt;
    try { evt = JSON.parse(raw.toString()); } catch { return; }

    // Send Elena's audio to Twilio
    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({
        event: "media", streamSid, media: { payload: evt.delta }
      }));
    }

    // Customer transcript — save + detect goodbye
    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      const text = evt.transcript || "";
      fullTranscript.push(`Cliente: ${text}`);
      console.log(`👤 Cliente: ${text}`);

      const t = text.toLowerCase();
      const goodbyes = ["bye", "goodbye", "good bye", "adios", "adiós",
                        "hasta luego", "chao", "chau", "nos vemos", "take care",
                        "have a good day", "have a great day", "talk to you later",
                        "see you", "thank you bye", "gracias adios", "gracias adiós"];
      const saidGoodbye = goodbyes.some(w => t.includes(w));
      if (saidGoodbye && !hangupScheduled) {
        console.log("👋 Cliente se despidió");
        scheduleHangup(4000);
      }
    }

    // Elena transcript — save + detect [HANGUP] or farewell phrases
    if (evt.type === "response.audio_transcript.done") {
      const text = evt.transcript || "";
      fullTranscript.push(`Elena: ${text}`);
      console.log(`🤖 Elena: ${text}`);

      const elenaGoodbyes = ["[hangup]", "have a great day", "have a wonderful day",
        "goodbye", "take care", "que tenga", "buen día", "buenas tardes", "hasta luego"];
      const elenaIsDone = elenaGoodbyes.some(w => text.toLowerCase().includes(w));

      if (elenaIsDone && !hangupScheduled) {
        console.log("📴 Elena se despidió — colgando");
        scheduleHangup(2500);
      }
    }

    if (evt.type === "error") {
      console.error("❌ OpenAI error:", JSON.stringify(evt.error));
    }
  });

  // ── Twilio messages ────────────────────────────────────────
  twilioWs.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      callSid   = msg.start.callSid;
      console.log(`📞 Llamada iniciada | callSid: ${callSid} | caller: ${callerPhone}`);

      // Fetch caller phone from Twilio API if not in URL
      if (!callerPhone || callerPhone === "unknown") {
        client.calls(callSid).fetch()
          .then(call => {
            callerPhone = call.from;
            console.log(`📱 Caller ID: ${callerPhone}`);
          })
          .catch(e => console.error("❌ No se pudo obtener caller:", e));
      }
    }

    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({
        type: "input_audio_buffer.append",
        audio: msg.media.payload
      }));
    }
  });

  // ── Call ended — send WhatsApp report ─────────────────────
  twilioWs.on("close", async () => {
    console.log("🔴 Llamada cerrada. Procesando reporte...");
    await new Promise(r => setTimeout(r, 2000));
    if (fullTranscript.length === 0) {
      console.log("⚠️ Transcript vacío — no se envía reporte");
      return;
    }

    const chat = fullTranscript.join("\n");
    console.log("📋 Transcript completo:\n" + chat);

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`,
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `Extract from this call transcript:
- name: full name of the customer
- phone: phone number the customer mentioned
- address: FULL street address — number, street name, city, state. Search the ENTIRE transcript carefully. Customer may have given it piece by piece. Include apartment/unit/zip if mentioned. This is critical — do not miss it.
- service: what the CUSTOMER said they need (use lines labeled "Cliente:" only). Include specifics: type, quantity, locations, brands. Never use Elena's words.
- appointment: exact confirmed day and time with real date (e.g. "Saturday March 8 at 10 AM"). Never just "next Saturday".
Return ONLY valid JSON: { "name": "", "phone": "", "address": "", "service": "", "appointment": "" }
If a field is truly missing use "Not provided".`,
            },
            { role: "user", content: chat },
          ],
          response_format: { type: "json_object" },
        }),
      });

      const jsonRes = await res.json();
      const info = JSON.parse(jsonRes.choices[0].message.content);
      console.log("📊 Datos extraídos:", info);

      const phoneToShow = (info.phone && info.phone !== "Not provided")
        ? info.phone
        : (callerPhone || "Not provided");

      const whatsappBody =
        `🚀 *ORDEN TÉCNICA DOMOTIK*\n\n` +
        `👤 *NOMBRE:* ${(info.name || "Not provided").toUpperCase()}\n` +
        `📞 *TEL:* ${phoneToShow}\n` +
        `📍 *DIR:* ${info.address || "Not provided"}\n` +
        `🔧 *SERVICIO:* ${info.service || "Not provided"}\n` +
        `📅 *CITA:* ${info.appointment || "No agendada"}`;

      await client.messages.create({
        body: whatsappBody,
        from: TWILIO_WHATSAPP,
        to: MI_WHATSAPP,
      });

      console.log("✅ WhatsApp enviado.");
    } catch (err) {
      console.error("❌ Error reporte:", err);
      // Fallback — save transcript locally so data is never lost
      const fs = await import("fs");
      const fallback = {
        timestamp: new Date().toISOString(),
        caller: callerPhone,
        transcript: chat,
      };
      fs.default.appendFileSync(
        "missed_reports.json",
        JSON.stringify(fallback) + "\n"
      );
      console.log("💾 Transcript guardado en missed_reports.json");
    }
  });

  oaWs.on("error",   e => console.error("OpenAI WS error:", e));
  twilioWs.on("error", e => console.error("Twilio WS error:", e));

  // ── Hangup helper ──────────────────────────────────────────
  function scheduleHangup(delayMs) {
    if (hangupScheduled) return;
    hangupScheduled = true;
    setTimeout(() => {
      if (callSid) {
        client.calls(callSid)
          .update({ status: "completed" })
          .catch(e => console.error("❌ Error colgando:", e));
      }
      twilioWs.close();
    }, delayMs);
  }
});

// ── Twilio webhook ─────────────────────────────────────────
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
);
