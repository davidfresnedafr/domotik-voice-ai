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

// --- CONVERSIÓN ESTRICTA DE AUDIO PARA TWILIO ---
function linearToMuLawSample(sample) {
    const MU_LAW_MAX = 0x1FFF;
    const BIAS = 0x84;
    let sign = (sample >> 8) & 0x80;
    if (sign) sample = -sample;
    if (sample > MU_LAW_MAX) sample = MU_LAW_MAX;
    sample = sample + BIAS;
    let exponent = 7;
    for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; expMask >>= 1) { exponent--; }
    let mantissa = (sample >> (exponent + 3)) & 0x0F;
    let muLawByte = ~(sign | (exponent << 4) | mantissa);
    return muLawByte & 0xFF;
}

function pcm24kToUlaw8kBase64(pcmBuf) {
    const int16 = new Int16Array(pcmBuf.buffer, pcmBuf.byteOffset, Math.floor(pcmBuf.byteLength / 2));
    const outLen = Math.floor(int16.length / 3);
    const ulaw = Buffer.alloc(outLen);
    let j = 0;
    for (let i = 0; i < int16.length; i += 3) { ulaw[j++] = linearToMuLawSample(int16[i]); }
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
        const ulawBase64 = pcm24kToUlaw8kBase64(pcmBuf);
        const ulawRaw = Buffer.from(ulawBase64, "base64");
        const chunks = [];
        for (let i = 0; i < ulawRaw.length; i += 160) {
            chunks.push(ulawRaw.subarray(i, i + 160).toString("base64"));
        }
        return chunks;
    } catch (e) { return []; }
}

// --- LÓGICA DE CONEXIÓN ---
wss.on("connection", (twilioWs) => {
    let streamSid = null;
    let greeted = false;
    let speaking = false;
    let textBuffer = "";

    const oaWs = new WebSocket(`wss://api.openai.com/v1/realtime?model=${REALTIME_MODEL}`, {
        headers: { "Authorization": `Bearer ${OPENAI_API_KEY}`, "OpenAI-Beta": "realtime=v1" }
    });

    oaWs.on("open", () => {
        // SESIÓN: Solo texto para que no haya conflicto de audio binario
        oaWs.send(JSON.stringify({
            type: "session.update",
            session: {
                modalities: ["text"], 
                instructions: "Eres un asistente de Domotik Solutions. Responde siempre en español de forma breve.",
                input_audio_format: "g711_ulaw",
                output_audio_format: "g711_ulaw",
                turn_detection: { type: "server_vad" }
            }
        }));
    });

    twilioWs.on("message", (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.event === "start") {
            streamSid = msg.start.streamSid;
            console.log("🚀 Stream activo:", streamSid);
        }
        if (msg.event === "media" && !speaking && oaWs.readyState === WebSocket.OPEN) {
            oaWs.send(JSON.stringify({ type: "input_audio_buffer.append", audio: msg.media.payload }));
        }
    });

    oaWs.on("message", async (raw) => {
        const evt = JSON.parse(raw.toString());

        // Manejo de Texto
        if (evt.type === "response.text.delta") textBuffer += evt.delta;

        // Saludo Inicial
        if (evt.type === "session.updated" && !greeted) {
            greeted = true;
            console.log("➡️ Enviando saludo inicial...");
            oaWs.send(JSON.stringify({
                type: "conversation.item.create",
                item: { type: "message", role: "assistant", content: [{ type: "text", text: "Hola, bienvenido a Domotik Solutions. ¿En qué puedo ayudarte hoy?" }] }
            }));
            oaWs.send(JSON.stringify({ type: "response.create" }));
        }

        // Ejecución de Audio
        if (evt.type === "response.done") {
            const finalPárrafo = textBuffer.trim();
            textBuffer = "";

            if (finalPárrafo) {
                console.log("🔊 Generando audio para:", finalPárrafo);
                speaking = true;
                const chunks = await ttsToUlawChunks(finalPárrafo);
                
                let i = 0;
                const inst = setInterval(() => {
                    if (i >= chunks.length || twilioWs.readyState !== WebSocket.OPEN) {
                        clearInterval(inst);
                        setTimeout(() => { speaking = false; }, 400);
                        return;
                    }
                    twilioWs.send(JSON.stringify({ event: "media", streamSid, media: { payload: chunks[i++] } }));
                }, 20);
            }
        }
    });

    twilioWs.on("close", () => oaWs.close());
});

app.post("/twilio/voice", (req, res) => {
    res.type("text/xml").send(`<Response><Connect><Stream url="wss://${(PUBLIC_BASE_URL || req.headers.host).trim()}/media-stream" /></Connect></Response>`);
});

server.listen(PORT, () => console.log(`🟢 Servidor en puerto ${PORT}`));
