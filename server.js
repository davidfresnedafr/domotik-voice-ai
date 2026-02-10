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

    const oaWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview`, {
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
                instructions: "You are a Domotik assistant. Speak English primarily, Spanish if the user does. BE CONCISE. Start with: 'Hello, how can I help you today?'",
                voice: "alloy",
                input_audio_format: "g711_ulaw",
                output_audio_format: "g711_ulaw",
                input_audio_transcription: { model: "whisper-1" }, // ACTIVAMOS TRANSCRIPCIÓN LIGERA
                turn_detection: { 
                    type: "server_vad",
                    threshold: 0.3, // MUCHO MÁS SENSIBLE (Antes 0.5/0.6)
                    prefix_padding_ms: 500,
                    silence_duration_ms: 600
                }
            }
        }));
    });

    oaWs.on("message", (raw) => {
        const evt = JSON.parse(raw.toString());

        if (evt.type === "session.updated" && !greeted && streamSid) {
            greeted = true;
            console.log("🚀 ID Confirmado. Lanzando saludo...");
            oaWs.send(JSON.stringify({ type: "response.create" }));
        }

        if (evt.type === "response.audio.delta" && evt.delta) {
            twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
        }

        // LOG CRÍTICO: Aquí veremos qué está entendiendo la IA
        if (evt.type === "conversation.item.input_audio_transcription.completed") {
            console.log("🎙️ IA ENTENDIÓ:", evt.transcript);
        }
        
        if (evt.type === "error") {
            console.error("❌ ERROR DE OPENAI:", evt.error);
        }
    });

    twilioWs.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        
        if (msg.event === "start") {
            streamSid = msg.start.streamSid;
            console.log("📞 TWILIO RECIBIENDO AUDIO - ID:", streamSid);
        }

        if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
            // Log de ráfaga para confirmar que el audio fluye (solo verás puntos)
            process.stdout.write("."); 
            oaWs.send(JSON.stringify({
                type: "input_audio_buffer.append",
                audio: msg.media.payload
            }));
        }
    });

    twilioWs.on("close", () => { console.log("🏁 Llamada terminada"); if (oaWs.readyState === WebSocket.OPEN) oaWs.close(); });
});

app.post("/twilio/voice", (req, res) => {
    res.type("text/xml").send(`
        <Response>
            <Say language="en-US">Connecting now.</Say>
            <Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect>
            <Pause length="40"/>
        </Response>`);
});

server.listen(PORT, () => console.log(`🚀 Sistema en puerto ${PORT}`));
