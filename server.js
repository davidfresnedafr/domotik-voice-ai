import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const PUBLIC_BASE_URL = "domotik-voice-ai.onrender.com";

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

// --- CONFIGURACIÓN DE ELENA ---
const SYSTEM_INSTRUCTIONS = `
Your name is Elena, the elite AI representative for DOMOTIK SOLUTIONS LLC in South Florida.
1. START ALWAYS IN ENGLISH: "Thank you for calling Domotik Solutions LLC, your experts in automation and security. My name is Elena, how can I help you today?"
2. BE BILINGUAL: If the customer speaks Spanish, switch immediately to a professional and elegant Spanish.
3. CRITICAL DATA: You MUST capture: Name, Phone Number, and Service Address. Even if you have the caller ID, ask the customer to confirm their best contact number.
4. PRICING: If asked about technical visits, mention the evaluation fee you established ($150-$200).
5. CLOSING: Summarize the appointment details and end professionally.
`;

wss.on("connection", (twilioWs) => {
    let streamSid = null;
    let callerNumber = "Unknown"; // Para capturar el número real del cliente

    const oaWs = new WebSocket("wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview", {
        headers: {
            Authorization: `Bearer ${OPENAI_API_KEY}`,
            "OpenAI-Beta": "realtime=v1"
        }
    });

    oaWs.on("open", () => {
        oaWs.send(JSON.stringify({
            type: "session.update",
            session: {
                modalities: ["text", "audio"],
                instructions: SYSTEM_INSTRUCTIONS,
                voice: "shimmer",
                input_audio_format: "g711_ulaw",
                output_audio_format: "g711_ulaw",
                turn_detection: { type: "server_vad", threshold: 0.6 }, // Ajustado para evitar costos extra por ruido
                temperature: 0.7
            }
        }));
    });

    oaWs.on("message", (raw) => {
        const evt = JSON.parse(raw.toString());
        if (evt.type === "response.audio.delta" && streamSid) {
            twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: evt.delta } }));
        }
    });

    twilioWs.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.event === "start") {
            streamSid = msg.start.streamSid;
            // Captura el número de quien llama desde los datos de Twilio
            callerNumber = msg.start.customParameters?.from || "Not detected";
            console.log(`📞 Llamada entrante de: ${callerNumber}`);
        }
        if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
            oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
        }
    });

    twilioWs.on("close", () => {
        console.log(`🔴 Llamada de ${callerNumber} finalizada. Generando reporte...`);
        if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
    });
});

// Endpoint para Twilio
app.post("/twilio/voice", (req, res) => {
    res.type("text/xml").send(`
        <Response>
            <Connect>
                <Stream url="wss://${PUBLIC_BASE_URL}/media-stream">
                    <Parameter name="from" value="${req.body.From || 'Unknown'}" />
                </Stream>
            </Connect>
            <Pause length="1"/>
        </Response>
    `);
});

server.listen(PORT, () => {
    console.log(`🚀 Elena de Domotik Solutions lista en puerto ${PORT}`);
});
