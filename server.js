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
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `Your name is Elena from DOMOTIK SOLUTIONS LLC.
        - START ALWAYS IN ENGLISH: "Thank you for calling Domotik Solutions LLC. I'm Elena, how can I help you today?"
        - BILINGUAL: Switch to Spanish immediately if the caller speaks Spanish.
        - DATA: Be professional and collect Name, Phone Number, and Service Address.
        - HANG UP: When you hear 'bye', 'thank you', 'adios', or 'gracias', say a warm goodbye and STOP talking.`,
        voice: "shimmer",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad", threshold: 0.8, silence_duration_ms: 1000 }
      }
    }));
    
    setTimeout(() => {
      oaWs.send(JSON.stringify({
        type: "response.create",
        response: { instructions: "Introduce yourself in English as Elena from Domotik Solutions LLC." }
      }));
    }, 600);
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());
    if (evt.type === "response.audio.delta" && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    if (evt.type === "conversation.item.input_audio_transcription.completed" || evt.type === "response.audio_transcript.done") {
      const text = (evt.transcript || "").toLowerCase();
      if (text.trim()) fullTranscript.push(text);
      
      const keywords = ["bye", "thank you", "adios", "adiós", "gracias"];
      if (keywords.some(word => text.includes(word))) {
        setTimeout(async () => {
          if (callSid) {
            try { 
              await client.calls(callSid).update({ status: 'completed' }); 
              console.log("✅ Llamada finalizada exitosamente.");
            } catch (e) { console.error("Error al colgar:", e.message); }
          }
        }, 2000);
      }
    }
  });

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      callSid = msg.start.callSid; // Crítico para evitar el error de invalid CallSid
      callerNumber = msg.start.customParameters?.from || "Unknown";
      console.log(`📞 Conectado: ${callerNumber}`);
    }
    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
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
              { role: "system", content: `Extract customer info. Use ${callerNumber} if phone is missing. Format: JSON.` },
              { role: "user", content: chat }
            ],
            response_format: { type: "json_object" }
          })
        });
        const jsonRes = await response.json();
        const info = JSON.parse(jsonRes.choices[0].message.content);
        
        await client.messages.create({
          body: `🚀 *ORDEN TÉCNICA DOMOTIK LLC*\n👤: ${info.name || 'No capturado'}\n📞: ${info.phone || callerNumber}\n📍: ${info.address || 'No capturada'}\n\n📝 HISTORIAL:\n${chat.slice(-400)}`,
          from: TWILIO_WHATSAPP, to: MI_WHATSAPP
        });
      } catch (err) { console.error("Error en reporte:", err); }
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
      <Pause length="30"/>
    </Response>`);
});

server.listen(PORT, () => console.log(`🚀 Elena Activa para Domotik Solutions`));
