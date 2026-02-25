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
app.use(express.urlencoded({ extended: false })); // ✅ leer body de Twilio
const server = http.createServer(app);

// ✅ WebSocketServer sin path fijo — lo manejamos manualmente para leer query params
const wss = new WebSocketServer({ noServer: true });

// ✅ Upgrade manual para capturar el query string (?caller=+1...)
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
  // ✅ Extraer caller del query string que pusimos en el TwiML
  const url = new URL(req.url, `http://localhost`);
  let callerPhone = url.searchParams.get("caller") || null;
  console.log(`📱 callerPhone desde URL: ${callerPhone}`);

  let streamSid = null;
  let callSid = null;
  let fullTranscript = [];
  let hangupScheduled = false;

  const oaWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
  });

  oaWs.on("open", () => {
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `You are Elena, a professional receptionist from Bogotá, Colombia working for Domotik Solutions LLC.

        PERSONALITY & SPEECH STYLE (CRITICAL):
        - Speak naturally and conversationally, like a real person — NOT like a robot or formal assistant.
        - Use a warm, friendly Bogotá Colombian tone. Use natural Colombian expressions when appropriate (e.g. "claro que sí", "con mucho gusto", "cómo le parece", "listo").
        - Speak at a normal, natural pace — not slow, not robotic. Be concise and direct.
        - Do NOT over-explain. Keep responses short and to the point.
        - Never repeat the same phrase twice in a row.

        LANGUAGE DETECTION: After your greeting (always in English), listen to the customer. If they speak Spanish, switch immediately to natural Colombian Spanish. If English, stay in English but keep the warm tone.

        STRICT RULES:
        1. NO PRICES: Never give prices for products, cameras, or labor.
        2. SERVICE VISIT: Explain that a technician must visit to provide a professional quote.
        3. VISIT COST & CREDIT: The technical visit costs $125 — and those $125 become a credit toward their final invoice if they hire us.
        4. DATA COLLECTION: Collect Name, Phone, Address, and THE SPECIFIC SERVICE needed. If the customer does not provide their phone number, do not ask — it will be captured automatically.
        5. TERMINATION: When the customer says goodbye (e.g. "bye", "goodbye", "adios", "hasta luego", "chao", "nos vemos"), say a warm short farewell and output [HANGUP].`,
        voice: "shimmer",        // ✅ voz femenina más natural
        speed: 1.25,             // ✅ 25% más rápido — ahorra tokens y suena humano
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: {
          type: "server_vad",
          threshold: 0.6,
          silence_duration_ms: 600, // ✅ un poco menos de pausa entre turnos
          prefix_padding_ms: 200
        }
      }
    }));

    // ✅ Saludo exacto, forzado palabra por palabra, siempre en inglés
    oaWs.send(JSON.stringify({
      type: "response.create",
      response: {
        instructions: `Say EXACTLY this in English, word for word, no changes:
"Thank you for calling Domotik Solutions LLC, your trusted home and building automation experts. My name is Elena, how can I help you today?"`
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());

    // Barge-in: cliente interrumpe a Elena
    if (evt.type === "input_audio_buffer.speech_started" && streamSid) {
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      oaWs.send(JSON.stringify({ type: "response.cancel" }));
    }

    // Audio de Elena → Twilio
    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    // Transcripción del cliente
    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      fullTranscript.push(`Cliente: ${evt.transcript}`);
    }

    // Transcripción de Elena — detectar [HANGUP]
    if (evt.type === "response.audio_transcript.done") {
      fullTranscript.push(`Elena: ${evt.transcript}`);

      if (evt.transcript.includes("[HANGUP]") && !hangupScheduled) {
        hangupScheduled = true;
        setTimeout(() => {
          if (callSid) {
            client.calls(callSid).update({ status: "completed" }).catch((e) =>
              console.error("❌ Error colgando llamada:", e)
            );
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
      console.log(`📞 Llamada iniciada | callSid: ${callSid} | callerPhone URL: ${callerPhone}`);

      // ✅ Si no llegó por URL, lo buscamos directamente en la API de Twilio
      if (!callerPhone || callerPhone === "unknown") {
        client.calls(callSid).fetch()
          .then((call) => {
            callerPhone = call.from;
            console.log(`📱 callerPhone desde API Twilio: ${callerPhone}`);
          })
          .catch((e) => console.error("❌ No se pudo obtener caller desde API:", e));
      }
    }

    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", async () => {
    console.log("🔴 Llamada cerrada. Procesando reporte...");

    await new Promise((resolve) => setTimeout(resolve, 2000));

    if (fullTranscript.length === 0) return;

    const chat = fullTranscript.join("\n");

    try {
      const response = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: "gpt-4o-mini",
          messages: [
            {
              role: "system",
              content: `Extract from this call transcript:
- name
- phone
- address
- service (type of service requested)
Return JSON: { "name": "", "phone": "", "address": "", "service": "" }
If a field is missing, use "Not provided".`
            },
            { role: "user", content: chat }
          ],
          response_format: { type: "json_object" }
        })
      });

      const jsonRes = await response.json();
      const info = JSON.parse(jsonRes.choices[0].message.content);

      // ✅ Usar Caller ID si el cliente no dio su número
      const phoneToShow = (info.phone && info.phone !== "Not provided")
        ? info.phone
        : (callerPhone || "Not provided");

      // ✅ WhatsApp limpio — solo los 4 datos
      await client.messages.create({
        body:
          `🚀 *ORDEN TÉCNICA DOMOTIK*\n\n` +
          `👤 *NOMBRE:* ${info.name.toUpperCase()}\n` +
          `📞 *TEL:* ${phoneToShow}\n` +
          `📍 *DIR:* ${info.address}\n` +
          `🔧 *SERVICIO:* ${info.service}`,
        from: TWILIO_WHATSAPP,
        to: MI_WHATSAPP
      });

      console.log("✅ WhatsApp enviado con éxito.");
    } catch (err) {
      console.error("❌ Error enviando reporte:", err);
    }
  });
});

// ✅ Webhook de Twilio — captura el Caller ID del POST body y lo pasa al WebSocket
app.post("/twilio/voice", (req, res) => {
  const callerNumber = req.body?.From || "unknown";
  console.log(`📲 Llamada entrante desde: ${callerNumber}`);

  res
    .type("text/xml")
    .send(
      `<Response><Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream?caller=${encodeURIComponent(callerNumber)}" /></Connect></Response>`
    );
});

server.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Servidor Activo en Puerto ${PORT}`)
);
