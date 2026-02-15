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

  const oaWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
  });

  oaWs.on("open", () => {
    // 1. CONFIGURAR LA SESIÓN
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `Your name is Elena from Domotik Solutions. 
        PITCH: "Hi! I'm Elena from Domotik Solutions. We install and repair Smart Home systems and Business Security. How can I help you?"
        GOAL: Collect Name, Phone, and Address.
        TERMINATION: If the user says 'Bye', 'Goodbye', 'Adiós' or 'Thank you', say 'Goodbye' and the call will end.`,
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 800 }
      }
    }));

    // 2. FORZAR SALUDO INICIAL (Elena habla primero)
    oaWs.send(JSON.stringify({
      type: "response.create",
      response: {
        instructions: "Introduce yourself immediately: 'Hi! I'm Elena from Domotik Solutions. We specialize in Smart Home and Business Security. How can I help you today?'"
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());

    // Manejo de Interrupción
    if (evt.type === "input_audio_buffer.speech_started" && streamSid) {
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      oaWs.send(JSON.stringify({ type: "response.cancel" }));
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      const text = evt.transcript.toLowerCase();
      fullTranscript.push(`Cliente: ${evt.transcript}`);
      
      // LOGICA DE CIERRE URGENTE
      const despedidas = ["bye", "goodbye", "adiós", "adios", "nos vemos", "thank you", "thanks"];
      if (despedidas.some(palabra => text.includes(palabra))) {
        console.log("Terminando llamada por despedida...");
        setTimeout(() => {
          if (streamSid) {
            client.calls(streamSid).update({ status: 'completed' }).catch(() => {});
          }
          twilioWs.close();
        }, 1500); // Pequeño margen para que Elena diga "Goodbye"
      }
    }

    if (evt.type === "response.audio_transcript.done") {
      fullTranscript.push(`Elena: ${evt.transcript}`);
    }
  });

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") streamSid = msg.start.streamSid;
    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", async () => {
    if (fullTranscript.length > 2) {
      const chat = fullTranscript.join('\n');
      const phone = chat.match(/(\d[\s-]?){7,12}/g)?.pop()?.replace(/\s/g, '') || "❌ No capturado";
      const nameMatch = chat.match(/Cliente: (?:Hi, I'm|I am|My name is|Soy|Me llamo) ([\w\s]+)/i);
      const name = nameMatch ? nameMatch[1].trim() : "Ver chat";

      await client.messages.create({
        body: `📋 *NUEVA ORDEN - DOMOTIK*\n👤 NOMBRE: ${name}\n📞 TEL: ${phone}\n\n📝 CHAT:\n${chat.slice(-600)}`,
        from: TWILIO_WHATSAPP, to: MI_WHATSAPP
      }).catch(console.error);
    }
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`
    <Response>
      <Connect>
        <Stream url="wss://${PUBLIC_BASE_URL}/media-stream" />
      </Connect>
    </Response>
  `);
});

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Elena v30.0 Proactive Active`));
