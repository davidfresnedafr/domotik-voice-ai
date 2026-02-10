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
  let fullTranscript = ""; // Para guardar lo que se habló

  // 🕒 LÍMITE DE COSTO: Cortar llamada tras 3 minutos (180000 ms)
  const callTimeout = setTimeout(() => {
    console.log("⚠️ Límite de tiempo alcanzado para ahorrar crédito.");
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  }, 180000);

  const oaWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
  });

  oaWs.on("open", () => {
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        // INSTRUCCIONES ULTRA-BREVES PARA AHORRAR DINERO
        instructions: `Eres el vendedor de Domotik Solutions. 
        OBJETIVO: Agendar visitas. 
        REGLA DE COSTO: Sé extremadamente breve, responde en menos de 10 palabras siempre que sea posible. 
        Si agendan, di 'Perfecto, anotado' y cuelga. Si dicen bye, cuelga.`,
        voice: "echo",
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: { type: "server_vad", threshold: 0.4, silence_duration_ms: 600 }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());
    if (evt.type === "session.updated") { sessionReady = true; if (streamSid) tryGreet(); }

    if (evt.type === "input_audio_buffer.speech_started") {
      if (streamSid) twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      oaWs.send(JSON.stringify({ type: "response.cancel" }));
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    // Capturar transcripción para el reporte final
    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      fullTranscript += ` Cliente: ${evt.transcript}\n`;
    }
    if (evt.type === "response.audio_transcript.done") {
      fullTranscript += ` IA: ${evt.transcript}\n`;
    }

    // Autocuelgue por despedida
    if (evt.type === "response.done") {
      const text = (evt.response?.output?.[0]?.content?.[0]?.transcript || "").toLowerCase();
      if (text.includes("adiós") || text.includes("bye") || text.includes("anotado")) {
        setTimeout(() => { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); }, 2000);
      }
    }
  });

  const tryGreet = () => {
    if (!greeted && sessionReady) {
      greeted = true;
      oaWs.send(JSON.stringify({
        type: "response.create",
        response: { modalities: ["audio", "text"], instructions: "Saluda corto: 'Domotik Solutions, ¿dígame?'" }
      }));
    }
  };

  twilioWs.on("message", (raw) => {
    const msg = JSON.parse(raw.toString());
    if (msg.event === "start") { streamSid = msg.start.streamSid; tryGreet(); }
    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
    }
  });

  twilioWs.on("close", () => {
    clearTimeout(callTimeout);
    console.log("\n--- REPORTE DE LA LLAMADA ---");
    console.log(fullTranscript); 
    console.log("--- FIN DEL REPORTE ---\n");
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`<Response><Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect><Pause length="40"/></Response>`);
});

server.listen(PORT, () => console.log(`🚀 Control de costos activo en puerto ${PORT}`));
