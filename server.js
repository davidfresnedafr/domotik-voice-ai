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
  let fullTranscript = [];
  let callerNumber = "Unknown";

  const oaWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
  });

  oaWs.on("open", () => {
    // 1. INSTRUCCIONES ULTRA-ESTRICTAS
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `Your name is Elena, an elite representative for DOMOTIK SOLUTIONS LLC.
        - ALWAYS START IN ENGLISH: "Thank you for calling Domotik Solutions LLC, your experts in smart home and security. I'm Elena, how can I help you today?"
        - BILINGUAL: If the user speaks Spanish, switch to professional Spanish.
        - DATA: Collect Name, Phone, and Address. 
        - HANG UP: When the user says 'bye', 'thank you', 'adios', or 'gracias', say a brief professional goodbye and YOU MUST STOP TALKING immediately.`,
        voice: "shimmer",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad", threshold: 0.5 }
      }
    }));

    // 2. SALUDO INMEDIATO FORZADO
    setTimeout(() => {
      oaWs.send(JSON.stringify({
        type: "response.create",
        response: { instructions: "Introduce yourself as Elena from Domotik Solutions LLC in English right now." }
      }));
    }, 500);
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());
    
    if (evt.type === "response.audio.delta" && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    // 3. LÓGICA DE CIERRE AUTOMÁTICO (TRIGGER)
    if (evt.type === "conversation.item.input_audio_transcription.completed" || evt.type === "response.audio_transcript.done") {
      const text = (evt.transcript || "").toLowerCase();
      fullTranscript.push(text);
      
      const keywords = ["bye", "thank you", "adios", "adiós", "gracias", "finalizar"];
      if (keywords.some(word => text.includes(word))) {
        console.log("🎯 Palabra de cierre detectada. Colgando...");
        setTimeout(async () => {
          if (streamSid) {
            try {
              await client.calls(streamSid).update({ status: 'completed' });
            } catch (e) { console.error("Error al colgar:", e); }
          }
        }, 3000); // Espera 3 segundos para que Elena termine de decir adiós
      }
    }
  });

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      callerNumber = msg.start.customParameters?.from || "Unknown";
      console.log(`📞 Llamada de: ${callerNumber}`);
    }
    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", async () => {
    console.log("🔴 Conexión cerrada. Generando reporte...");
    if (fullTranscript.length > 5) { // Solo si hubo conversación real
      const chat = fullTranscript.join('\n');
      try {
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${OPENAI_API_KEY}` },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: `Extract Name, Phone, and Address. Use ${callerNumber} if phone is missing. Format: JSON.` },
              { role: "user", content: chat }
            ],
            response_format: { type: "json_object" }
          })
        });
        const jsonRes = await response.json();
        const info = JSON.parse(jsonRes.choices[0].message.content);
        
        await client.messages.create({
          body: `🚀 *NUEVA ORDEN DOMOTIK LLC*\n👤: ${info.name}\n📞: ${info.phone}\n📍: ${info.address}`,
          from: TWILIO_WHATSAPP, to: MI_WHATSAPP
        });
      } catch (err) { console.error("Error reporte:", err); }
    }
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
      <Pause length="40"/> 
    </Response>`);
});

server.listen(PORT, () => console.log(`🚀 Elena Activa para Domotik Solutions`));
