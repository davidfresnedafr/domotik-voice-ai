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
        instructions: `Your name is Elena from Domotik Solutions. 
        PITCH: "Hi! I'm Elena from Domotik Solutions. We specialize in Smart Home and Business Security for Residential and Commercial clients. How can I help you today?"
        
        STRICT RULES:
        1. NO PRICES: Never give prices for cameras, systems, or labor. 
        2. SERVICE VISIT: Explain that a technician must visit to provide a quote. The technical visit costs exactly $125.
        3. DATA COLLECTION: Collect Name, Phone, Address, and Service Needed.
        4. BILINGUAL: If they speak Spanish, switch to professional Spanish.
        5. TERMINATION: If they say 'Bye' or 'Thank you', say goodbye and the call will end.`,
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { 
          type: "server_vad", 
          threshold: 0.8, // SUBIDO PARA IGNORAR RUIDOS EXTERNOS
          silence_duration_ms: 1000 
        }
      }
    }));

    oaWs.send(JSON.stringify({
      type: "response.create",
      response: { instructions: "Greet the customer immediately with the pitch in English." }
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

    if (evt.type === "conversation.item.input_audio_transcription.completed" || evt.type === "response.audio_transcript.done") {
      const text = (evt.transcript || "").toLowerCase();
      if (text.trim()) fullTranscript.push(text);
      
      const keywords = ["bye", "adios", "adiós", "gracias", "thank you"];
      if (keywords.some(word => text.includes(word))) {
        // RETRASO DE 4 SEGUNDOS PARA QUE TERMINE DE HABLAR ANTES DE CORTAR
        setTimeout(async () => {
          if (callSid) {
            try { 
              await client.calls(callSid).update({ status: 'completed' }); 
              console.log("✅ Llamada finalizada tras despedida.");
            } catch (e) { console.error("Error al colgar:", e.message); }
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
              { role: "system", content: `Extract: Name, Phone, Address, and Service. Use ${callerNumber} if phone is missing. Format: JSON { "name": "", "phone": "", "address": "", "service": "" }.` },
              { role: "user", content: chat }
            ],
            response_format: { type: "json_object" }
          })
        });

        const jsonRes = await response.json();
        const info = JSON.parse(jsonRes.choices[0].message.content);

        await client.messages.create({
          body: `🚀 *NUEVA ORDEN DOMOTIK LLC*\n\n` +
                `👤 *NOMBRE:* ${info.name.toUpperCase()}\n` +
                `📞 *TEL:* ${info.phone}\n` +
                `📍 *DIR:* ${info.address}\n` +
                `🛠️ *SERVICIO:* ${info.service}`,
          from: TWILIO_WHATSAPP, to: MI_WHATSAPP
        });
      } catch (err) { console.error("❌ Error en reporte:", err); }
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

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor Domotik Activo`));
