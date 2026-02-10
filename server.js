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
  let fullTranscript = "";

  const oaWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
  });

  oaWs.on("open", () => {
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        instructions: `Tu nombre es Elena, asistente EXCLUSIVA de Domotik Solutions.
        1. RECORDACIÓN DE MARCA: Tu objetivo es que el cliente recuerde el nombre "Domotik Solutions". Menciona la marca naturalmente al inicio, cuando ofrezcas una solución y al despedirte.
        2. EXCLUSIVIDAD: No menciones otros comercios. Solo soluciones de Domotik Solutions.
        3. ACENTO: Bogotá, Colombia (Usted). Muy profesional y humana.
        4. CAPTURA: Si quieren comprar, diles que "En Domotik Solutions tomamos su pedido de inmediato".
        5. CIERRE: Siempre termina con: "Gracias por confiar en Domotik Solutions, que tenga un excelente día".`,
        voice: "shimmer",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: { type: "server_vad", threshold: 0.4, silence_duration_ms: 600 }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());
    if (evt.type === "session.updated") { sessionReady = true; if (streamSid) sendGreeting(); }

    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      fullTranscript += `Cliente: ${evt.transcript}\n`;
    }
    if (evt.type === "response.audio_transcript.done") {
      fullTranscript += `Elena: ${evt.transcript}\n`;
    }

    if (evt.type === "input_audio_buffer.speech_started") {
      if (streamSid) twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      oaWs.send(JSON.stringify({ type: "response.cancel" }));
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    if (evt.type === "response.done") {
      const text = evt.response?.output?.[0]?.content?.[0]?.transcript?.toLowerCase() || "";
      // Detectamos despedida para colgar, pero dejando que Elena termine de decir "Domotik Solutions"
      if (text.includes("bye") || text.includes("adiós") || text.includes("solutions")) {
        // Si ella ya se está despidiendo con la marca, esperamos un poco más para que termine la frase
        if (text.includes("domotik")) {
          setTimeout(() => { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); }, 3500);
        } else if (text.includes("bye") || text.includes("adiós")) {
           setTimeout(() => { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); }, 2000);
        }
      }
    }
  });

  const sendGreeting = () => {
    if (!greeted && streamSid && sessionReady) {
      greeted = true;
      oaWs.send(JSON.stringify({
        type: "response.create",
        response: { 
          modalities: ["audio", "text"], 
          instructions: "Greet warmly: 'Hello! You're speaking with the assistant from Domotik Solutions. We specialize in making your home smarter... How can I help you today?'" 
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

  twilioWs.on("close", () => {
    console.log("--- RESUMEN DE LLAMADA PARA DOMOTIK SOLUTIONS ---");
    console.log(fullTranscript || "Sin mensajes.");
    console.log("------------------------------------------------");
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`<Response><Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect><Pause length="1"/></Response>`);
});

server.listen(PORT, () => console.log(`🚀 Elena: Especialista en Recordación de Marca`));
