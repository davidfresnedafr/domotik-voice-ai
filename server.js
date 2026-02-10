import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const PUBLIC_BASE_URL = "domotik-voice-ai.onrender.com";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

// Auto-ping para intentar mitigar el spin down del plan gratuito
setInterval(() => {
    fetch(`https://${PUBLIC_BASE_URL}/twilio/voice`, { method: 'POST' }).catch(() => {});
}, 300000);

wss.on("connection", (twilioWs) => {
    let streamSid = null;
    let greeted = false;

    const oaWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview`, {
        headers: { 
            "Authorization": `Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=v1" 
        }
    });

    oaWs.on("open", () => {
        console.log("✅ Conectado a OpenAI. Configurando...");
        oaWs.send(JSON.stringify({
            type: "session.update",
            session: {
                modalities: ["text", "audio"],
                instructions: "Your main language is English. If the user speaks Spanish, respond in Spanish. Be extremely concise. Start immediately with: 'Hello, welcome to Domotik Solutions, how can I help you?'",
                voice: "alloy",
                input_audio_format: "g711_ulaw",
                output_audio_format: "g711_ulaw",
                turn_detection: { 
                    type: "server_vad",
                    threshold: 0.6,
                    silence_duration_ms: 800 
                }
            }
        }));

        // Saludo forzado para activar el audio de Twilio rápidamente
        setTimeout(() => {
            if (!greeted) {
                greeted = true;
                console.log("🚀 Disparando Saludo Forzado...");
                oaWs.send(JSON.stringify({ type: "response.create" }));
            }
        }, 1200);
    });

    oaWs.on("message", (raw) => {
        const evt = JSON.parse(raw.toString());

        // Reenvío directo de audio de OpenAI a Twilio
        if (evt.type === "response.audio.delta" && evt.delta) {
            twilioWs.send(JSON.stringify({
                event: "media",
                streamSid,
                media: { payload: evt.delta }
            }));
        }

        if (evt.type === "conversation.item.input_audio_transcription.completed") {
            console.log("🎙️ Usuario dijo:", evt.transcript);
        }
    });

    twilioWs.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.event === "start") {
            streamSid = msg.start.streamSid;
            console.log("📞 Stream activo:", streamSid);
        }
        if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
            oaWs.send(JSON.stringify({
                type: "input_audio_buffer.append",
                audio: msg.media.payload
            }));
        }
    });

    twilioWs.on("close", () => { if (oaWs.readyState === WebSocket.OPEN) oaWs.close(); });
    oaWs.on("error", (e) => console.error("❌ Error OpenAI:", e.message));
});

app.post("/twilio/voice", (req, res) => {
    res.type("text/xml").send(`
        <Response>
            <Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect>
            <Pause length="40"/>
        </Response>`);
});

server.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
