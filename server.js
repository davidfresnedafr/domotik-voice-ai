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
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

wss.on("connection", (twilioWs) => {
  let streamSid = null;
  let callSid = null; 
  let fullTranscript = [];
  let callerNumber = "Unknown";

  const oaWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
  });

  oaWs.on("open", () => {
    // Limpiamos cualquier residuo de audio antes de configurar la sesión
    oaWs.send(JSON.stringify({ type: "input_audio_buffer.clear" }));

    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `Your name is Elena, the professional AI agent for Domotik Solutions LLC. 
        SALUDO INICIAL: "Thank you for calling Domotik Solutions LLC. My name is Elena, how can I help you today?"
        RULES:
        1. NO PRICES.
        2. SERVICE VISIT: $125 cost, which becomes CREDIT if service is hired.
        3. DATA: Get Name, Phone, Address, and Service Needed.
        4. TERMINATION: Hang up on 'Bye', 'Thank you', 'Adios', 'Gracias'.`,
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { 
          type: "server_vad", 
          threshold: 0.8, // Más alto para ignorar ruidos estáticos
          silence_duration_ms: 120000 // 2 min de silencio
        }
      }
    }));

    // Retraso mayor para asegurar que el WebSocket esté "limpio" antes del saludo
    setTimeout(() => {
      if (oaWs.readyState === WebSocket.OPEN) {
        oaWs.send(JSON.stringify({
          type: "response.create",
          response: { instructions: "Introduce yourself professionaly as Elena from Domotik Solutions LLC." }
        }));
      }
    }, 1500);
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());

    // Evitamos enviar paquetes de audio vacíos o corruptos que generan ruido
    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    if (evt.type === "input_audio_buffer.speech_started" && streamSid) {
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
    }

    if (evt.type === "conversation.item.input_audio_transcription.completed" || evt.type === "response.audio_transcript.done") {
      const text = (evt.transcript || "").toLowerCase();
      if (text.trim()) fullTranscript.push(text);
      
      const keywords = ["bye", "adios", "adiós", "gracias", "thank you"];
      if (keywords.some(word => text.includes(word))) {
        setTimeout(async () => {
          if (callSid) {
            try { await client.calls(callSid).update({ status: 'completed' }); } 
            catch (e) { console.error("Error al colgar:", e.message); }
          }
        }, 4000); 
      }
    }
  });

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      callSid = msg.start.callSid; 
      callerNumber = msg.start.customParameters?.from || "Unknown";
      console.log("📞 Llamada iniciada correctamente.");
    }
    // Solo enviamos audio a OpenAI si es un evento de media válido
    if (msg.event === "media" && msg.media && msg.media.payload && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", async () => {
    if (fullTranscript.length > 2) {
      const chat = fullTranscript.join('\n');
      try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: `Extract Name, Phone, Address, Service. Use ${callerNumber} if missing. JSON.` },
              { role: "user", content: chat }
            ],
            response_format: { type: "json_object" }
          })
        });

        const jsonRes = await response.json();
        const info = JSON.parse(jsonRes.choices[0].message.content);

        await client.messages.create({
          body: `🚀 *ORDEN DOMOTIK LLC*\n\n👤: ${info.name.toUpperCase()}\n📞: ${info.phone}\n📍: ${info.address}\n🛠️: ${info.service}`,
          from: TWILIO_WHATSAPP, to: MI_WHATSAPP
        });
      } catch (err) { console.error("Error reporte:", err); }
    }
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  const fromNum = req.body.From || 'Unknown';
  res.type("text/xml").send(`
    <Response>
      <Connect>
        <Stream url="wss://${PUBLIC_BASE_URL}/media-stream">
          <Parameter name="from" value="${fromNum}" />
        </Stream>
      </Connect>
      <Pause length="120"/>
    </Response>`);
});

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Elena Activa (Sin ruidos de inicio)`));
