import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const PUBLIC_BASE_URL = "domotik-voice-ai.onrender.com";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

wss.on("connection", (twilioWs) => {
  let streamSid = null;
  let greeted = false;
  let sessionReady = false;

  const oaWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
  });

  oaWs.on("open", () => {
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `Tu nombre es Elena, asistente ejecutiva de Domotik Solutions. 
        
        UBICACIÓN ESTRATÉGICA:
        - Operamos EXCLUSIVAMENTE en South Florida (Miami, Fort Lauderdale, Palm Beach, y alrededores).
        - Si mencionan Colombia u otros países, aclara que aunque tu acento es de Bogotá, la empresa es 100% local de Florida.
        
        PERFIL HIGH-END:
        - Ofrece soluciones integrales de lujo: iluminación inteligente, cine en casa de alta gama y seguridad avanzada.
        - Tu lenguaje debe ser sofisticado. No hables de "barato", habla de "inversión en confort" y "sistemas de alto desempeño".

        LOGICA DE INTERRUPCIÓN Y CIERRE:
        - Si el cliente habla, CÁLLATE de inmediato.
        - Si detectas una despedida (bye, adiós, chao, hasta luego, gracias), confirma la despedida y la llamada se cortará automáticamente.`,
        voice: "shimmer",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        turn_detection: { 
          type: "server_vad", 
          threshold: 0.7, // Umbral alto para ignorar soplidos del micro
          prefix_padding_ms: 300,
          silence_duration_ms: 800 
        }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());
    if (evt.type === "session.updated") { sessionReady = true; if (streamSid) sendGreeting(); }

    // Interrupción activa
    if (evt.type === "input_audio_buffer.speech_started") {
      if (streamSid) twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      oaWs.send(JSON.stringify({ type: "response.cancel" }));
    }

    // Lógica de COLGADO REFORZADA
    if (evt.type === "response.done") {
      const text = evt.response?.output?.[0]?.content?.[0]?.transcript?.toLowerCase() || "";
      const despedidas = ["bye", "goodbye", "adiós", "chao", "hasta luego", "que tenga un buen día", "nos vemos"];
      
      if (despedidas.some(palabra => text.includes(palabra))) {
        console.log("Cierre de llamada detectado...");
        setTimeout(() => { 
          if (twilioWs.readyState === WebSocket.OPEN) {
            twilioWs.send(JSON.stringify({ event: "clear", streamSid })); // Limpia audio pendiente
            twilioWs.close(); 
          }
        }, 2000); // 2 segundos para que termine de decir "Gracias por llamar a Domotik Solutions"
      }
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }
  });

  const sendGreeting = () => {
    if (!greeted && streamSid && sessionReady) {
      greeted = true;
      oaWs.send(JSON.stringify({
        type: "response.create",
        response: { 
          modalities: ["audio", "text"], 
          instructions: "Greeting: 'Hello! You are speaking with Elena from Domotik Solutions, providing premium automation here in South Florida. How may I assist you with your project today?'" 
        }
      }));
    }
  };

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") { streamSid = msg.start.streamSid; if (sessionReady) sendGreeting(); }
    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", () => { if (oaWs.readyState === WebSocket.OPEN) oaWs.close(); });
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`<Response><Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect><Pause length="1"/></Response>`);
});

server.listen(PORT, () => console.log(`🚀 Elena High-
