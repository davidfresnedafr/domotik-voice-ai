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
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

wss.on("connection", (twilioWs) => {
  let streamSid = null;
  let callSid = null; // ✅ FIX 1: separado de streamSid
  let fullTranscript = [];
  let hangupScheduled = false; // ✅ FIX 3: evita colgadas duplicadas

  const oaWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
  });

  oaWs.on("open", () => {
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `Your name is Elena, the professional AI agent for Domotik Solutions LLC.
        PITCH: "Thank you for calling Domotik Solutions LLC. My name is Elena, how can I help you today?"
        
        STRICT RULES:
        1. NO PRICES: Never give prices for products, cameras, or labor.
        2. SERVICE VISIT: Explain that a technician must visit to provide a professional quote.
        3. VISIT COST & CREDIT: The technical visit costs $125. IMPORTANT: Tell the customer that these $125 will become a CREDIT toward their final invoice if they decide to hire our services.
        4. DATA COLLECTION: Collect Name, Phone, Address, and THE SPECIFIC SERVICE needed.
        5. BILINGUAL: If they speak Spanish, switch to professional Spanish immediately.
        6. TERMINATION: When the customer clearly says goodbye to END the call (e.g. "bye", "goodbye", "adios", "hasta luego", "nos vemos"), thank them warmly and say [HANGUP].`,
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: {
          type: "server_vad",
          threshold: 0.6,       // ✅ FIX: filtro de ruido balanceado
          silence_duration_ms: 800, // ✅ FIX 2: era 120000 (2 min!) → ahora 800ms
          prefix_padding_ms: 300
        }
      }
    }));

    oaWs.send(JSON.stringify({
      type: "response.create",
      response: { instructions: "Greet the customer immediately with the pitch." }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());

    // Barge-in: el cliente interrumpe a Elena
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

      // ✅ FIX 3: solo cuelga si Elena dice [HANGUP], no por "gracias" del cliente
      if (evt.transcript.includes("[HANGUP]") && !hangupScheduled) {
        hangupScheduled = true;
        setTimeout(() => {
          if (callSid) {
            // ✅ FIX 1: usa callSid, NO streamSid
            client.calls(callSid).update({ status: "completed" }).catch((e) =>
              console.error("❌ Error colgando llamada:", e)
            );
          }
          twilioWs.close();
        }, 2500); // pequeño delay para que Elena termine de hablar
      }
    }
  });

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      callSid = msg.start.callSid; // ✅ FIX 1: capturamos el callSid correcto
      console.log(`📞 Llamada iniciada | callSid: ${callSid}`);
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
      // Analista GPT — extrae datos del cliente
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

      // Envío por WhatsApp
      await client.messages.create({
        body:
          `🚀 *ORDEN TÉCNICA DOMOTIK*\n\n` +
          `👤 *NOMBRE:* ${info.name.toUpperCase()}\n` +
          `📞 *TEL:* ${info.phone}\n` +
          `📍 *DIR:* ${info.address}\n` +
          `🔧 *SERVICIO:* ${info.service}\n\n` +
          `📝 *HISTORIAL:*\n${chat.slice(-600)}`,
        from: TWILIO_WHATSAPP,
        to: MI_WHATSAPP
      });

      console.log("✅ WhatsApp enviado con éxito.");
    } catch (err) {
      console.error("❌ Error enviando reporte:", err);
    }
  });
});

app.post("/twilio/voice", (req, res) => {
  res
    .type("text/xml")
    .send(
      `<Response><Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect></Response>`
    );
});

server.listen(PORT, "0.0.0.0", () =>
  console.log(`🚀 Servidor Activo en Puerto ${PORT}`)
);
