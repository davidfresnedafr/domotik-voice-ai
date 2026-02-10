import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000; // Ajustado al puerto que muestra tu log
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const PUBLIC_BASE_URL = "domotik-voice-ai.onrender.com";
const REALTIME_MODEL = "gpt-4o-realtime-preview";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

// Auto-ping para mantener vivo el proceso
setInterval(() => {
    fetch(`https://${PUBLIC_BASE_URL}/twilio/voice`, { method: 'POST' }).catch(() => {});
}, 300000); // Cada 5 minutos para mayor seguridad

wss.on("connection", (twilioWs) => {
    let streamSid = null;
    let greeted = false;

    const oaWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`, {
        headers: { 
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=v1" 
        }
    });

    oaWs.on("open", () => {
        oaWs.send(JSON.stringify({
            type: "session.update",
            session: {
                modalities: ["text", "audio"], 
                instructions: "Responde de inmediato: 'Hola, bienvenido a Domotik Solutions, ¿en qué puedo ayudarte?'. Sé muy breve.",
                voice: "alloy",
                input_audio_format: "g711_ulaw",
                output_audio_format: "g711_ulaw",
                turn_detection: { type: "server_vad" }
            }
        }));
    });

    oaWs.on("message", (raw) => {
        const evt = JSON.parse(raw.toString());

        // Disparar saludo apenas la sesión confirme la actualización
        if (evt.type === "session.updated" && !greeted) {
            greeted = true;
            console.log("🗣️ Sesión lista. Disparando saludo inicial...");
            oaWs.send(JSON.stringify({ type: "response.create" }));
        }

        // Mover audio de OpenAI a Twilio sin procesar (Directo)
        if (evt.type === "response.audio.delta" && evt.delta) {
            twilioWs.send(JSON.stringify({
                event: "media",
                streamSid,
                media: { payload: evt.delta }
            }));
        }
    });

    twilioWs.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.event === "start") {
            streamSid = msg.start.streamSid;
            console.log("🚀 Stream activo:", streamSid);
        }
        // Mover audio de Twilio a OpenAI (Directo)
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
            <Pause length="40"/>
        </Response>`);
});

server.listen(PORT, () => console.log(`🚀 Sistema operativo en puerto ${PORT}`));
