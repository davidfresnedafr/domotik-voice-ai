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
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `Your name is Elena from Domotik Solutions.
        PITCH: "Hi! I'm Elena from Domotik Solutions. We install and repair Smart Home systems and Business Security for Residential and Commercial clients. How can I help you today?"
        
        GOAL: You MUST collect Name, Phone, and Address. Ask for the Name early.
        RULES:
        - If the customer says 'Bye', 'Goodbye' or 'Adiós', say 'Goodbye' and STOP.
        - Be direct. No filler words.`,
        voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { type: "server_vad", threshold: 0.5, silence_duration_ms: 800 }
      }
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
      const text = evt.transcript.toLowerCase();
      fullTranscript.push(`Cliente: ${evt.transcript}`);
      if (text.includes("bye") || text.includes("adios") || text.includes("gracias")) {
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
    if (msg.event === "start") streamSid = msg.start.streamSid;
    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", async () => {
    if (fullTranscript.length > 2) {
      const chat = fullTranscript.join('\n');
      
      // EXTRACCIÓN MEJORADA
      const phone = chat.match(/(\d[\s-]?){7,12}/g)?.pop()?.replace(/\s/g, '') || "❌ No capturado";
      
      // Captura el nombre después de frases comunes de presentación
      const nameMatch = chat.match(/Cliente: (?:Hi, I'm|I am|This is|My name is|Soy|Me llamo) ([\w\s]+)/i);
      const name = nameMatch ? nameMatch[1].trim() : "Ver chat";
      
      const addressMatch = chat.match(/(?:\d+\s+[\w\s]+(?:Street|St|Ave|Avenue|Drive|Dr|Road|Rd|Way|Lane|Ln|Boulevard|Blvd))/i);
      const address = addressMatch ? addressMatch[0] : "Ver chat";

      await client.messages.create({
        body: `📋 *ORDEN DE TRABAJO - DOMOTIK*\n\n👤 NOMBRE: ${name}\n📞 TEL: ${phone}\n📍 DIRECCIÓN: ${address}\n\n📝 RESUMEN:\n${chat.slice(-600)}`,
        from: TWILIO_WHATSAPP, to: MI_WHATSAPP
      }).catch(e => console.error("WhatsApp error:", e.message));
    }
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`<Response><Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect></Response>`);
});

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Dispatcher Ready on Port ${PORT}`));
