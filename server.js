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

  // Límite de 5 minutos para controlar el gasto de créditos
  const callTimeout = setTimeout(() => {
    if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close();
  }, 300000);

  const oaWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
  });

  oaWs.on("open", () => {
    oaWs.send(JSON.stringify({
      type: "session.update",
      session: {
        modalities: ["text", "audio"],
        // ✅ INSTRUCCIONES PARA VOZ AMABLE Y LATINA
        instructions: `
          Eres 'Elena', la asistente amable de Domotik Solutions. 
          TU TONO: Dulce, servicial y muy profesional. 
          TU ACENTO: Habla en Español Latino neutro (evita acento de España).
          TU OBJETIVO: Ayudar al cliente con su hogar inteligente y agendar una visita técnica.
          REGLAS:
          1. Si te hablan en inglés, responde en inglés, pero tu prioridad es el español.
          2. No seas cortante. Saluda con calidez.
          3. Para agendar la cita, pide el nombre y un horario.
          4. Si el cliente dice 'adiós' o 'bye', despídete con mucha cortesía antes de terminar.`,
        voice: "shimmer", // ✅ Voz femenina amable
        input_audio_format: "g711_ulaw",
        output_audio_format: "g711_ulaw",
        input_audio_transcription: { model: "whisper-1" },
        turn_detection: { 
          type: "server_vad", 
          threshold: 0.4, 
          silence_duration_ms: 800 // ✅ Más tiempo de espera para no ser cortante
        }
      }
    }));
  });

  oaWs.on("message", (raw) => {
    const evt = JSON.parse(raw.toString());
    if (evt.type === "session.updated") { sessionReady = true; if (streamSid) tryGreet(); }

    // Interrupción suave
    if (evt.type === "input_audio_buffer.speech_started") {
      if (streamSid) twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
      oaWs.send(JSON.stringify({ type: "response.cancel" }));
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
    }

    // Registro de lo hablado para el reporte
    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      fullTranscript += `Cliente: ${evt.transcript}\n`;
    }
    if (evt.type === "response.audio_transcript.done") {
      fullTranscript += `Elena: ${evt.transcript}\n`;
    }

    // Cierre inteligente
    if (evt.type === "response.done") {
      const text = (evt.response?.output?.[0]?.content?.[0]?.transcript || "").toLowerCase();
      if (text.includes("adiós") || text.includes("bye") || text.includes("luego")) {
        setTimeout(() => { if (twilioWs.readyState === WebSocket.OPEN) twilioWs.close(); }, 3000);
      }
    }
  });

  const tryGreet = () => {
    if (!greeted && sessionReady) {
      greeted = true;
      oaWs.send(JSON.stringify({
        type: "response.create",
        response: { 
          modalities: ["audio", "text"], 
          instructions: "Saluda cálidamente: 'Hola, gracias por llamar a Domotik Solutions. Soy Elena, ¿en qué puedo ayudarle hoy?'" 
        }
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
    console.log("\n--- DATOS DE LA VENTA / CITA ---");
    console.log(fullTranscript); 
    console.log("-------------------------------\n");
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`<Response><Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect><Pause length="40"/></Response>`);
});

server.listen(PORT, () => console.log(`🚀 Elena activa en Domotik Solutions`));
