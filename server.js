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
        instructions: `You are Elena, receptionist for Domotik Solutions LLC. Be warm, concise, human — never robotic. Short answers only.

LANGUAGE: Greet in English. Then match customer language (English or Spanish). Never switch mid-call.
NOISY CALL: Ask to repeat twice, then offer callback and say [HANGUP].

COLLECT IN ORDER — do not skip steps, do not proceed to next until current is confirmed:
1. NAME (ask first, do not continue until you have it)
2. SERVICE (ask: "What exactly do you need?" — get specifics: type, quantity, location. Do not continue until specific.)
3. ADDRESS — MANDATORY before scheduling. Ask: "What is the full address where you need the service?" Do NOT schedule without a street address and city. If they skip it, ask again before moving on.
4. APPOINTMENT (ONLY after name + service + address are all confirmed) — Mon-Fri 8am-6pm normal rate. Saturdays with extra charge. No Sundays.

RULES:
- No prices for labor or products ever.
- Visit fee: $125 (becomes credit if they hire us).
- Services offered: security cameras, smart home, home theater, cabling, access control, alarms, intercoms, AV, electrical work, thermostat install.
- Area: South Florida only (Port St. Lucie to Florida Keys). Ask address early — if outside area say so and [HANGUP].
- Out of scope service → apologize and [HANGUP].
- Customer says goodbye → short farewell → [HANGUP].`,
        voice: "shimmer",
        speed: 1.35,              // ✅ más rápido = menos segundos de audio = menos costo
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        max_response_output_tokens: 150, // ✅ limita respuestas largas innecesarias
        turn_detection: {
          type: "server_vad",
          threshold: 0.95,
          silence_duration_ms: 800,  // ✅ reducido: menos tiempo escuchando silencio = menos tokens
          prefix_padding_ms: 300,
        },
      },
    }));

    oaWs.send(JSON.stringify({
      type: "response.create",
      response: {
        instructions: `Say EXACTLY this in English, word for word, no changes:
"Thank you for calling Domotik Solutions LLC, your trusted home and building automation experts. My name is Elena, how can I help you today?"`,
      },
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());

    if (evt.type === "input_audio_buffer.speech_started" && streamSid) {
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      oaWs.send(JSON.stringify({ type: "response.cancel" }));
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      const customerText = evt.transcript.toLowerCase();
      fullTranscript.push(`Cliente: ${evt.transcript}`);

      // ✅ Detect goodbye from CUSTOMER side too
      const goodbyeWords = ["bye", "goodbye", "good bye", "adios", "adiós", "hasta luego", "chao", "chau", "nos vemos", "take care", "thank you so much bye"];
      const saidGoodbye = goodbyeWords.some(w => customerText.includes(w));
      if (saidGoodbye && !hangupScheduled) {
        console.log("👋 Customer said goodbye — scheduling hangup");
        hangupScheduled = true;
        setTimeout(() => {
          if (callSid) {
            client.calls(callSid).update({ status: "completed" })
              .catch((e) => console.error("❌ Hangup error:", e));
          }
          twilioWs.close();
        }, 4000); // 4s so Elena can finish her farewell
      }
    }

    if (evt.type === "response.audio_transcript.done") {
      fullTranscript.push(`Elena: ${evt.transcript}`);

      // ✅ Detect [HANGUP] from Elena transcript
      if (evt.transcript.includes("[HANGUP]") && !hangupScheduled) {
        hangupScheduled = true;
        setTimeout(() => {
          if (callSid) {
            client.calls(callSid).update({ status: "completed" })
              .catch((e) => console.error("❌ Hangup error:", e));
          }
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
          .then((call) => {
            callerPhone = call.from;
            console.log(`📱 callerPhone desde API: ${callerPhone}`);
          })
          .catch((e) => console.error("❌ No se pudo obtener caller:", e));
      }
    }

    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", async () => {
    console.log("🔴 Llamada cerrada. Procesando reporte...");
    await new Promise((r) => setTimeout(r, 2000));
    if (fullTranscript.length === 0) return;

    const chat = fullTranscript.join("\n");

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
- phone: phone number mentioned by the customer
- address: FULL street address including street number, street name, city, and state. Search carefully through the entire transcript — the customer may have given it piece by piece or in passing. Include every detail they mentioned (apartment, unit, zip code if given).
- service: what the CUSTOMER (not Elena) said they need. Use the customer lines only (labeled "Cliente:"). Include specifics like number of cameras, locations, rooms, devices, or brands. NEVER use Elena's words or suggestions as the service description.
- appointment: exact day and time confirmed for the technician visit. Write as a specific date if possible (e.g. "Saturday February 29 at 12 PM") not just "Next Saturday".
Return JSON: { "name": "", "phone": "", "address": "", "service": "", "appointment": "" }
IMPORTANT: For address, piece together ALL location details mentioned anywhere in the conversation. If truly not provided, use "Not provided".`,
            },
            { role: "user", content: chat },
          ],
          response_format: { type: "json_object" },
        }),
      });

      const jsonRes = await res.json();
      const info = JSON.parse(jsonRes.choices[0].message.content);

      const phoneToShow = (info.phone && info.phone !== "Not provided")
        ? info.phone
        : (callerPhone || "Not provided");

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

      console.log("✅ WhatsApp enviado con éxito.");
    } catch (err) {
      console.error("❌ Error enviando reporte:", err);
    }
  });

  oaWs.on("error", (e) => console.error("OpenAI WS error:", e));
  twilioWs.on("error", (e) => console.error("Twilio WS error:", e));
});

app.post("/twilio/voice", (req, res) => {
  const callerNumber = req.body?.From || "unknown";
  console.log(`📲 Llamada entrante desde: ${callerNumber}`);

  res.type("text/xml").send(
    `<Response><Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream?caller=${encodeURIComponent(callerNumber)}" /></Connect></Response>`
  );
});

server.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Domotik Voice AI corriendo en puerto ${PORT}`)
);
