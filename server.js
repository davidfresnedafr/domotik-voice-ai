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
        // Configuración mínima y robusta
        oaWs.send(JSON.stringify({
            type: "session.update",
            session: {
                modalities: ["text", "audio"],
                instructions: "You are a bilingual assistant. English is primary. If the user speaks Spanish, answer in Spanish. Say exactly this right now: 'Hello, welcome to Domotik Solutions, how can I help you today?'",
                voice: "alloy",
                input_audio_format: "g711_ulaw",
                output_audio_format: "g711_ulaw",
                turn_detection: { type: "server_vad" }
            }
        }));
    });

    oaWs.on("message", (raw) => {
        const evt = JSON.parse(raw.toString());

        // Disparar saludo solo cuando Twilio nos de el ID
        if (evt.type === "session.updated" && !greeted && streamSid) {
            greeted = true;
            console.log("🚀 Lanzando saludo final al stream:", streamSid);
            oaWs.send(JSON.stringify({ type: "response.create" }));
        }

        // Reenvío de audio sin procesar nada
        if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
            twilioWs.send(JSON.stringify({
                event: "media",
                streamSid: streamSid,
                media: { payload: evt.delta }
            }));
        }
    });

    twilioWs.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        
        if (msg.event === "start") {
            streamSid = msg.start.streamSid;
            console.log("📞 Twilio Conectado - ID:", streamSid);
            
            // Si OpenAI ya abrió, saludamos ahora que tenemos el ID
            if (oaWs.readyState === WebSocket.OPEN && !greeted) {
                greeted = true;
                oaWs.send(JSON.stringify({ type: "response.create" }));
            }
        }

        if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
            oaWs.send(JSON.stringify({
                type: "input_audio_buffer.append",
                audio: msg.media.payload
            }));
        }
    });

    twilioWs.on("close", () => { if (oaWs.readyState === WebSocket.OPEN) oaWs.close(); });
});

// XML de Twilio modificado para ser más persistente
app.post("/twilio/voice", (req, res) => {
    res.type("text/xml").send(`
        <Response>
            <Say language="en-US">Connecting.</Say>
            <Connect>
                <Stream url="wss://${PUBLIC_BASE_URL}/media-stream" />
            </Connect>
            <Pause length="30"/>
        </Response>`);
});

server.listen(PORT, () => console.log(`🚀 Demo Lista`));
