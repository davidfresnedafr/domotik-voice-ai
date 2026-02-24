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
  let fullTranscript = [];
  let callerNumber = "Not provided"; // Captura automática

  const oaWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
  });

  oaWs.on("open", () => {
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `Your name is Elena, the elite AI representative for DOMOTIK SOLUTIONS LLC in South Florida.
        1. START ALWAYS IN ENGLISH: "Thank you for calling Domotik Solutions LLC, your experts in automation and security. My name is Elena, how can I help you today?"
        2. BE BILINGUAL: If the customer speaks Spanish, switch immediately to a professional and elegant Spanish.
        3. GOAL: You MUST collect Name, Phone number, and Service Address. Be persistent but polite.
        4. TERMINATION: If the user says 'Bye' or 'Thank you', say goodbye and hang up.`,
        voice: "shimmer",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad", threshold: 0.6, silence_duration_ms: 1000 }
      }
    }));

    // Forzamos el saludo inicial
    oaWs.send(JSON.stringify({
      type: "response.create",
      response: { instructions: "Greet the customer immediately in English as Elena from Domotik Solutions LLC." }
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

    // Captura de transcripciones para el reporte
    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      fullTranscript.push(`Cliente: ${evt.transcript}`);
      const text = evt.transcript.toLowerCase();
      if (text.includes("bye") || text.includes("adios") || text.includes("gracias") || text.includes("thank you")) {
        setTimeout(() => {
          if (streamSid) client.calls(streamSid).update({status: 'completed'}).catch(() => {});
          twilioWs.close();
        }, 2000);
      }
    }
    if (evt.type === "response.audio_transcript.done") {
      fullTranscript.push(`Elena: ${evt.transcript}`);
    }
  });

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") {
        streamSid = msg.start.streamSid;
        // Extraemos el número real del cliente desde los metadatos de Twilio
        callerNumber = msg.start.customParameters?.from || "Not provided";
    }
    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", async () => {
    console.log("🔴 Llamada cerrada. Procesando reporte para Domotik...");
    await new Promise(resolve => setTimeout(resolve, 2000));

    if (fullTranscript.length > 0) {
      const chat = fullTranscript.join('\n');
      try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: `Extract customer Name, Phone, and Address. 
                NOTE: If the customer didn't say their phone, use this one: ${callerNumber}.
                Format as JSON: { 'name': '', 'phone': '', 'address': '' }.` },
              { role: "user", content: chat }
            ],
            response_format: { type: "json_object" }
          })
        });

        const jsonRes = await response.json();
        const info = JSON.parse(jsonRes.choices[0].message.content);

        await client.messages.create({
          body: `🚀 *ORDEN TÉCNICA DOMOTIK LLC*\n\n` +
                `👤 *NOMBRE:* ${info.name.toUpperCase()}\n` +
                `📞 *TEL:* ${info.phone}\n` +
                `📍 *DIR:* ${info.address}\n\n` +
                `📝 *HISTORIAL:*\n${chat.slice(-600)}`,
          from: TWILIO_WHATSAPP, to: MI_WHATSAPP
        });
        console.log("✅ Reporte enviado a WhatsApp.");
      } catch (err) {
        console.error("❌ Error en reporte:", err);
      }
    }
  });
});

app.post("/twilio/voice", (req, res) => {
  // Pasamos el número del cliente al stream para capturarlo automáticamente
  res.type("text/xml").send(`
    <Response>
      <Connect>
        <Stream url="wss://${PUBLIC_BASE_URL}/media-stream">
          <Parameter name="from" value="${req.body.From || 'Unknown'}" />
        </Stream>
      </Connect>
    </Response>`);
});

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor Domotik Activo en Puerto ${PORT}`));
