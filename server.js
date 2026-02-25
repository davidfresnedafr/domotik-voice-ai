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
        instructions: `You are Elena, a professional AI receptionist for Domotik Solutions LLC.

PERSONALITY & SPEECH STYLE:
- Speak naturally and conversationally — NOT like a robot.
- Use a warm, friendly tone. Be concise and direct.
- Do NOT over-explain. Keep responses short and to the point.
- Never repeat the same phrase twice.
- NOISY ENVIRONMENT: If you cannot understand the customer due to background noise, say: "Sorry, there's a lot of background noise — could you repeat that?" After 2 failed attempts, say: "It seems very noisy — can I call you back? Just leave me your name and number." Then collect name and phone only and say [HANGUP].

LANGUAGE RULES (CRITICAL):
- Your greeting is ALWAYS in English — no exceptions.
- After the greeting, DETECT the language the customer uses in their FIRST response.
- If they speak English → respond ONLY in English for the entire call.
- If they speak Spanish → respond ONLY in Spanish for the entire call.
- If they mix both → follow the language they use MOST.
- NEVER switch languages mid-call unless the customer explicitly asks you to.
- NEVER assume Spanish just because of your name.

STRICT RULES:
1. NO PRICES: Never give prices for products, cameras, or labor.
2. SERVICE VISIT: Explain that a technician must visit the property to provide a professional quote.
3. VISIT COST & CREDIT: The technical visit costs $125 — and those $125 become a CREDIT toward the final invoice if the customer hires us.
4. DATA COLLECTION: You MUST collect ALL of the following IN THIS ORDER before scheduling or ending the call:
   a) Customer's NAME — ask early
   b) SPECIFIC SERVICE — ask exactly: "What specifically would you like us to help you with?" Then dig deeper: if they say cameras, ask HOW MANY and WHERE (indoor/outdoor, which areas). If electrical, ask what exactly. NEVER move to scheduling until you have a clear, specific service description.
   c) ADDRESS — full street address including city
   d) APPOINTMENT — only after you have name, service, and address confirmed
   Do NOT accept vague answers like "I need help" — always ask a follow-up to get specifics.
   SCHEDULE RULES — communicate clearly:
   (1) Monday to Friday 8am–6pm: normal rate.
   (2) Saturdays: available but with an additional charge — inform the customer before confirming.
   (3) Sundays and holidays: NOT available — offer next Monday or Saturday instead.
   Always confirm the final day and time back to the customer.
5. SERVICES: Domotik Solutions LLC offers: security cameras, smart home automation, home theater, structured cabling, access control, alarm systems, intercoms, AV installation, electrical work, and thermostat installation/replacement. If the customer requests anything outside this list, politely say it is outside your scope, thank them, and say [HANGUP].
6. SERVICE AREA: Domotik Solutions LLC serves South Florida from Port St. Lucie down to the Florida Keys, including St. Lucie, Martin, Palm Beach, Broward, Miami-Dade counties, and the Florida Keys (Key Largo, Marathon, Key West). Ask for the customer's address early to confirm they are within the service area. If they are outside this area, say: "Unfortunately we only service the South Florida area, from Port St. Lucie to the Florida Keys." Thank them and say [HANGUP].
7. TERMINATION: When the customer says goodbye (bye, goodbye, adios, hasta luego, chao, nos vemos), give a warm short farewell and say [HANGUP].`,
        voice: "shimmer",
        speed: 1.25,
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: {
          type: "server_vad",
          threshold: 0.95,
          silence_duration_ms: 1200,
          prefix_padding_ms: 500,
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
      fullTranscript.push(`Cliente: ${evt.transcript}`);
    }

    if (evt.type === "response.audio_transcript.done") {
      fullTranscript.push(`Elena: ${evt.transcript}`);

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
