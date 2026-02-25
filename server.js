import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";
import twilio from "twilio";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const PUBLIC_BASE_URL = "domotik-voice-ai.onrender.com";

const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
const MI_WHATSAPP = "whatsapp:+15617141075";
const TWILIO_WHATSAPP = "whatsapp:+14155238886";

const app = express();
app.use(express.urlencoded({ extended: false }));
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  if (req.url.startsWith("/media-stream")) {
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  } else {
    socket.destroy();
  }
});

wss.on("connection", (twilioWs, req) => {
  const url = new URL(req.url, "http://localhost");
  let callerPhone = url.searchParams.get("caller") || null;

  let streamSid = null;
  let callSid = null;
  let fullTranscript = [];
  let hangupScheduled = false;

  const oaWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: {
      Authorization: `Bearer ${OPENAI_API_KEY}`,
      "OpenAI-Beta": "realtime=v1",
    },
  });

  oaWs.on("open", () => {
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `You are Elena, receptionist for Domotik Solutions LLC. Be warm and human. Keep responses concise — 1-2 sentences max per turn.

LANGUAGE: Greet in English always. Then match the customer's language for the rest of the call (English or Spanish). Never switch mid-call.
NOISY CALL: If you can't understand, ask to repeat. After 2 failed attempts offer callback, collect name + phone only, say [HANGUP].

COLLECT IN THIS ORDER — never skip, never move to next step until current one is confirmed:
1. NAME — ask first. Do not continue without it.
2. SERVICE — ask "What exactly do you need?" Get specifics (type, quantity, location). Do not continue until you have a clear answer.
3. ADDRESS — ask "What is the full address?" including street number, street name and city. This is REQUIRED before scheduling. Do NOT move to step 4 without it.
4. APPOINTMENT — ask preferred day and time ONLY after steps 1-3 are done. Mon-Fri 8am-6pm normal rate. Saturdays available with extra charge. No Sundays.

RULES:
- Never give prices for labor or products.
- Visit fee is $125 — becomes credit toward final invoice if they hire us.
- Services: security cameras, smart home, home theater, cabling, access control, alarms, intercoms, AV, electrical work, thermostat install.
- Only serves South Florida (Port St. Lucie to Florida Keys). Confirm address is in this area. If outside, say so and [HANGUP].
- If service is outside scope, apologize and [HANGUP].
- When customer says goodbye → warm farewell → [HANGUP].`,
        voice: "shimmer",
        speed: 1.25,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        max_response_output_tokens: 200,
        turn_detection: {
          type: "server_vad",
          threshold: 0.9,   // high — only real voice triggers, ignores vibration/noise/TV
          silence_duration_ms: 1000, // wait 1s of silence before Elena responds
          prefix_padding_ms: 500,
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
    const evt = JSON.parse(raw.toString());

    // Barge-in DISABLED — no noise, vibration or background sound will interrupt Elena
    // Elena only stops when the VAD detects real sustained speech from the customer

    // Audio from Elena → Twilio
    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    // Customer transcript — detect goodbye
    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      fullTranscript.push(`Cliente: ${evt.transcript}`);
      const t = evt.transcript.toLowerCase();
      const goodbyes = ["bye", "goodbye", "good bye", "adios", "adiós", "hasta luego", "chao", "chau", "nos vemos", "take care", "gracias adiós", "gracias adios"];
      if (goodbyes.some(w => t.includes(w)) && !hangupScheduled) {
        console.log("👋 Cliente se despidió — colgando");
        hangupScheduled = true;
        setTimeout(() => {
          if (callSid) client.calls(callSid).update({ status: "completed" }).catch(console.error);
          twilioWs.close();
        }, 4000);
      }
    }

    // Elena transcript — detect [HANGUP]
    if (evt.type === "response.audio_transcript.done") {
      fullTranscript.push(`Elena: ${evt.transcript}`);
      if (evt.transcript.includes("[HANGUP]") && !hangupScheduled) {
        console.log("📴 Elena dijo [HANGUP] — colgando");
        hangupScheduled = true;
        setTimeout(() => {
          if (callSid) client.calls(callSid).update({ status: "completed" }).catch(console.error);
          twilioWs.close();
        }, 2500);
      }
    }
  });

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      callSid = msg.start.callSid;
      console.log(`📞 Llamada iniciada | callSid: ${callSid} | caller: ${callerPhone}`);

      if (!callerPhone || callerPhone === "unknown") {
        client.calls(callSid).fetch()
          .then(call => { callerPhone = call.from; console.log(`📱 Caller: ${callerPhone}`); })
          .catch(console.error);
      }
    }

    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", async () => {
    console.log("🔴 Llamada cerrada. Procesando reporte...");
    await new Promise(r => setTimeout(r, 2000));
    if (fullTranscript.length === 0) return;

    const chat = fullTranscript.join("\n");

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${OPENAI_API_KEY}` },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `Extract from this call transcript:
- name: full name of the customer
- phone: phone number mentioned by the customer
- address: FULL street address — number, street, city, state. Search the ENTIRE transcript carefully. Customer may have given it piece by piece. Include apartment/unit/zip if mentioned.
- service: what the CUSTOMER said they need (use lines labeled "Cliente:" only). Include all specifics: type, quantity, locations, brands. Never use Elena's words.
- appointment: exact confirmed day and time (e.g. "Saturday March 8 at 10 AM"). Not just "next Saturday".
Return JSON: { "name": "", "phone": "", "address": "", "service": "", "appointment": "" }
If a field is truly missing, use "Not provided".`,
            },
            { role: "user", content: chat },
          ],
          response_format: { type: "json_object" },
        }),
      });

      const jsonRes = await res.json();
      const info = JSON.parse(jsonRes.choices[0].message.content);

      const phoneToShow = (info.phone && info.phone !== "Not provided")
        ? info.phone : (callerPhone || "Not provided");

      await client.messages.create({
        body:
          `🚀 *ORDEN TÉCNICA DOMOTIK*\n\n` +
          `👤 *NOMBRE:* ${(info.name || "Not provided").toUpperCase()}\n` +
          `📞 *TEL:* ${phoneToShow}\n` +
          `📍 *DIR:* ${info.address || "Not provided"}\n` +
          `🔧 *SERVICIO:* ${info.service || "Not provided"}\n` +
          `📅 *CITA:* ${info.appointment || "No agendada"}`,
        from: TWILIO_WHATSAPP,
        to: MI_WHATSAPP,
      });

      console.log("✅ WhatsApp enviado.");
    } catch (err) {
      console.error("❌ Error reporte:", err);
    }
  });

  oaWs.on("error", e => console.error("OpenAI WS error:", e));
  twilioWs.on("error", e => console.error("Twilio WS error:", e));
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
