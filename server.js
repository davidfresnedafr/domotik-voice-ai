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
        instructions: `Your name is Elena, the professional AI agent for Domotik Solutions LLC. 
        PITCH: "Thank you for calling Domotik Solutions LLC. My name is Elena, how can I help you today?"
        
        STRICT RULES:
        1. NO PRICES: Never give prices for products, cameras, or labor. 
        2. SERVICE VISIT: Explain that a technician must visit to provide a professional quote. 
        3. VISIT COST & CREDIT: The technical visit costs $125. IMPORTANT: Tell the customer that these $125 will become a CREDIT toward their final invoice if they decide to hire our services.
        4. DATA COLLECTION: Collect Name, Phone, Address, and THE SPECIFIC SERVICE needed.
        5. BILINGUAL: If they speak Spanish, switch to professional Spanish immediately.
        6. TERMINATION: Hang up if the user says 'Bye', 'Thank you', 'Adios', or 'Gracias'.`,
      voice: "alloy",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { 
          type: "server_vad", 
          threshold: 0.8, // Filtro de ruidos fuerte
          silence_duration_ms: 120000 // 2 MINUTOS DE PACIENCIA
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

    // Manejo de audio y transcripción
    if (evt.type === "input_audio_buffer.speech_started" && streamSid) {
      twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      oaWs.send(JSON.stringify({ type: "response.cancel" }));
    }
    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    // CAPTURA DE TRANSCRIPCIÓN (Aseguramos que se guarde todo)
    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      fullTranscript.push(`Cliente: ${evt.transcript}`);
      const text = evt.transcript.toLowerCase();
      if (text.includes("bye") || text.includes("adios") || text.includes("adiós") || text.includes("gracias") || text.includes("thank you")) {
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
    console.log("🔴 Llamada cerrada. Procesando reporte...");
    
    // Esperamos 2 segundos para asegurar que todas las transcripciones entraron al array
    await new Promise(resolve => setTimeout(resolve, 2000));

    if (fullTranscript.length > 0) {
      const chat = fullTranscript.join('\n');
      
      try {
        // LLAMADA AL ANALISTA (FETCH)
        const response = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${OPENAI_API_KEY}`
          },
          body: JSON.stringify({
            model: "gpt-4o-mini",
            messages: [
              { role: "system", content: "Extract customer Name, Phone, and Address. Format as JSON: { 'name': '', 'phone': '', 'address': '' }. If a data is not there, search carefully in the text or put 'Not provided'." },
              { role: "user", content: chat }
            ],
            response_format: { type: "json_object" }
          })
        });

        const jsonRes = await response.json();
        const info = JSON.parse(jsonRes.choices[0].message.content);

        // ENVÍO WHATSAPP
        await client.messages.create({
          body: `🚀 *ORDEN TÉCNICA DOMOTIK*\n\n` +
                `👤 *NOMBRE:* ${info.name.toUpperCase()}\n` +
                `📞 *TEL:* ${info.phone}\n` +
                `📍 *DIR:* ${info.address}\n\n` +
                `📝 *HISTORIAL:*\n${chat.slice(-600)}`,
          from: TWILIO_WHATSAPP, to: MI_WHATSAPP
        });
        console.log("✅ WhatsApp enviado con éxito.");
      } catch (err) {
        console.error("❌ Error enviando reporte:", err);
      }
    }
  });
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`<Response><Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect></Response>`);
});

server.listen(PORT, '0.0.0.0', () => console.log(`🚀 Servidor Activo en Puerto ${PORT}`));

