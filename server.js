import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim();
const REALTIME_MODEL = "gpt-4o-realtime-preview";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

// Auto-ping para evitar que Render se duerma
setInterval(() => {
    fetch(`https://${PUBLIC_BASE_URL}/twilio/voice`, { method: 'POST' }).catch(() => {});
}, 600000);

wss.on("connection", (twilioWs) => {
    let streamSid = null;
    let greeted = false;

    // Conexión a OpenAI con Modalidad de Audio Nativa
    const oaWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`, {
        headers: { 
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=v1" 
        }
    });

    oaWs.on("open", () => {
        console.log("✅ OpenAI conectado");
        // Configuramos la sesión para que OpenAI gestione el audio (más rápido)
        oaWs.send(JSON.stringify({
            type: "session.update",
            session: {
                modalities: ["text", "audio"], 
                instructions: "Eres el asistente de Domotik Solutions. Habla español. Tu primera frase DEBE SER: 'Hola, bienvenido a Domotik Solutions, ¿en qué puedo ayudarte?'. Sé breve.",
                voice: "alloy",
                input_audio_format: "g711_ulaw",
                output_audio_format: "g711_ulaw",
                turn_detection: { type: "server_vad" }
            }
        }));
    });

    oaWs.on("message", (raw) => {
        const evt = JSON.parse(raw.toString());

        // 1. SALUDO INICIAL: En cuanto la sesión se actualiza, disparamos la respuesta
        if (evt.type === "session.updated" && !greeted) {
            greeted = true;
            console.log("🗣️ Sesión lista. Disparando saludo inicial...");
            oaWs.send(JSON.stringify({ type: "response.create" }));
        }

        // 2. REPRODUCCIÓN: Enviamos el audio delta directamente a Twilio
        if (evt.type === "response.audio.delta" && evt.delta) {
            twilioWs.send(JSON.stringify({
                event: "media",
                streamSid,
                media: { payload: evt.delta }
            }));
        }

        // Logs de control para ver qué está pasando
        if (evt.type === "response.audio_transcript.done") {
            console.log("🤖 Bot dijo:", evt.transcript);
        }
        
        if (evt.type === "error") {
            console.error("❌ Error de OpenAI:", evt.error);
        }
    });

    twilioWs.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.event === "start") {
            streamSid = msg.start.streamSid;
            console.log("📞 Stream activo:", streamSid);
        }
        // Enviamos el audio del usuario a OpenAI
        if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
            oaWs.send(JSON.stringify({
                type: "input_audio_buffer.append",
                audio: msg.media.payload
            }));
        }
    });

    twilioWs.on("close", () => { if (oaWs.readyState === WebSocket.OPEN) oaWs.close(); });
});

app.post("/twilio/voice", (req, res) => {
    res.type("text/xml").send(`
        <Response>
            <Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect>
            <Pause length="30"/>
        </Response>`);
});

server.listen(PORT, () => console.log(`🚀 Sistema operativo en puerto ${PORT}`));
