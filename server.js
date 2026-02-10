import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 3000;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const REALTIME_MODEL = "gpt-4o-realtime-preview"; 
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || "").trim();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

// --- AUTO-PING PARA RENDER ---
setInterval(() => {
    fetch(`https://${PUBLIC_BASE_URL}/twilio/voice`, { method: 'POST' })
        .then(() => console.log("⚓ Ping de mantenimiento enviado"))
        .catch(() => {});
}, 600000); // 10 minutos

// --- CONVERSIÓN DE AUDIO ---
function linearToMuLawSample(sample) {
    const MU_LAW_MAX = 0x1FFF; const BIAS = 0x84;
    let sign = (sample >> 8) & 0x80; if (sign) sample = -sample;
    if (sample > MU_LAW_MAX) sample = MU_LAW_MAX;
    sample = sample + BIAS; let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) { exponent--; }
    let mantissa = (sample >> (exponent + 3)) & 0x0F;
    return (~(sign | (exponent << 4) | mantissa)) & 0xFF;
}

function pcm24kToUlaw8kBase64(pcmBuf) {
    const int16 = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, Math.floor(pcmBuf.byteLength / 2));
    const ulaw = Buffer.alloc(Math.floor(int16.length / 3));
    for (let i = 0, j = 0; i < int16.length; i += 3) { ulaw[j++] = linearToMuLawSample(int16[i]); }
    return ulaw.toString("base64");
}

async function ttsToUlawChunks(text) {
    try {
        const resp = await fetch("https://api.openai.com/v1/audio/speech", {
            method: "POST",
            headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "Content-Type": "application/json" },
            body: JSON.stringify({ model: "tts-1", voice: "alloy", input: text, response_format: "pcm" }),
        });
        if (!resp.ok) return [];
        const pcmBuf = Buffer.from(await resp.arrayBuffer());
        const ulawRaw = Buffer.from(pcm24kToUlaw8kBase64(pcmBuf), "base64");
        const chunks = [];
        for (let i = 0; i < ulawRaw.length; i += 160) { chunks.push(ulawRaw.subarray(i, i + 160).toString("base64")); }
        return chunks;
    } catch (e) { return []; }
}

// --- LÓGICA WEBSOCKET ---
wss.on("connection", (twilioWs) => {
    let streamSid = null;
    let greeted = false;
    let speaking = false;
    let textBuffer = "";

    const oaWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`, {
        headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
    });

    oaWs.on("open", () => {
        oaWs.send(JSON.stringify({
            type: "session.update",
            session: {
                modalities: ["text"],
                instructions: "Eres el asistente de Domotik Solutions. Habla español y sé muy breve.",
                turn_detection: { type: "server_vad" }
            }
        }));
    });

    twilioWs.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.event === "start") streamSid = msg.start.streamSid;
        if (msg.event === "media" && !speaking && oaWs.readyState === WebSocket.OPEN) {
            oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
        }
    });

    oaWs.on("message", async (raw) => {
        const evt = JSON.parse(raw.toString());
        
        // CORRECCIÓN: Esperar a 'session.created' o 'session.updated' antes de enviar el saludo
        if ((evt.type === "session.created" || evt.type === "session.updated") && !greeted) {
            greeted = true;
            console.log("🗣️ Sesión lista. Enviando saludo...");
            setTimeout(() => {
                oaWs.send(JSON.stringify({
                    type: "conversation.item.create",
                    item: { type: "message", role: "assistant", content: [{ type: "text", text: "Hola, bienvenido a Domotik Solutions. ¿Cómo puedo ayudarte?" }] }
                }));
                oaWs.send(JSON.stringify({ type: "response.create" }));
            }, 500); // Pequeño delay para asegurar que el canal esté abierto
        }

        if (evt.type === "response.text.delta") textBuffer += evt.delta;

        if (evt.type === "response.done") {
            const content = textBuffer.trim(); textBuffer = "";
            if (content) {
                console.log("🔊 Reproduciendo:", content);
                speaking = true;
                const chunks = await ttsToUlawChunks(content);
                twilioWs.send(JSON.stringify({ event: "clear", streamSid }));
                let i = 0;
                const timer = setInterval(() => {
                    if (i >= chunks.length || twilioWs.readyState !== WebSocket.OPEN) {
                        clearInterval(timer);
                        setTimeout(() => { speaking = false; }, 500);
                        return;
                    }
                    twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: chunks[i++] } }));
                }, 20);
            }
        }
    });

    twilioWs.on("close", () => { if (oaWs.readyState === WebSocket.OPEN) oaWs.close(); });
});

app.post("/twilio/voice", (req, res) => {
    res.type("text/xml").send(`<Response><Connect><Stream url="wss://${PUBLIC_BASE_URL}/media-stream" /></Connect></Response>`);
});

server.listen(PORT, () => console.log(`🚀 Online en puerto ${PORT}`));
