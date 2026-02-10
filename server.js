import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const PORT = process.env.PORT || 10000;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || "").trim();
const PUBLIC_BASE_URL = "domotik-voice-ai.onrender.com";

if (!OPENAI_API_KEY) {
  console.error("❌ Falta OPENAI_API_KEY en variables de entorno");
}

const app = express();
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: "/media-stream" });

wss.on("connection", (twilioWs) => {
  let streamSid = null;
  let greeted = false;
  let sessionReady = false;

  const oaWs = new WebSocket(
    "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview",
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "OpenAI-Beta": "realtime=v1",
      },
    }
  );

  const tryGreet = () => {
    if (!greeted && streamSid && sessionReady && oaWs.readyState === WebSocket.OPEN) {
      greeted = true;
      console.log("🚀 Canal listo. Lanzando saludo de ventas...");

      oaWs.send(JSON.stringify({ type: "input_audio_buffer.clear" }));

      oaWs.send(
        JSON.stringify({
          type: "response.create",
          response: {
            modalities: ["audio", "text"], 
            instructions: "Greeting: 'Hola, gracias por llamar a Domotik Solutions. ¿En qué puedo ayudarle con su proyecto de automatización hoy?'",
          },
        })
      );
    }
  };

  oaWs.on("open", () => {
    console.log("✅ OpenAI WS conectado");
    oaWs.send(
      JSON.stringify({
        type: "session.update",
        session: {
          modalities: ["text", "audio"],
          // CONFIGURACIÓN DE COMPORTAMIENTO COMERCIAL
          instructions: `
            Eres el Asistente Virtual de Ventas de 'Domotik Solutions'. 
            TU OBJETIVO PRINCIPAL: Convencer al cliente de las ventajas de la domótica y AGENDAR UNA VISITA técnica en su domicilio.
            
            REGLAS DE CONVERSACIÓN:
            1. Preséntate siempre como parte de Domotik Solutions.
            2. Si preguntan qué hacemos, explica que automatizamos luces, persianas, seguridad y sonido para casas inteligentes.
            3. No hables de temas personales, política o cosas ajenas a la empresa.
            4. Si el cliente parece interesado, di: 'Lo ideal sería que un técnico visite su casa para darle un presupuesto exacto. ¿Le gustaría agendar una cita?'.
            5. Si acepta la cita, pide: Nombre, un número de contacto y si prefiere mañana o tarde.
            6. Sé breve y profesional. Usa un tono entusiasta pero serio.
            7. Habla en el idioma que el cliente elija (Español o Inglés).`,
          voice: "alloy",
          input_audio_format: "g711_ulaw",
          output_audio_format: "g711_ulaw",
          input_audio_transcription: { model: "whisper-1" },
          turn_detection: {
            type: "server_vad",
            threshold: 0.3,
            prefix_padding_ms: 500,
            silence_duration_ms: 600,
          },
        },
      })
    );
  });

  oaWs.on("message", (raw) => {
    let evt;
    try {
      evt = JSON.parse(raw.toString());
    } catch (e) { return; }

    if (evt.type === "session.updated") {
      sessionReady = true;
      tryGreet();
    }

    if (evt.type === "response.created") {
      console.log("🤖 OpenAI generando respuesta comercial...");
    }

    if (evt.type === "response.audio.delta" && evt.delta && streamSid) {
      twilioWs.send(
        JSON.stringify({
          event: "media",
          streamSid,
          media: { payload: evt.delta },
        })
      );
    }

    if (evt.type === "conversation.item.input_audio_transcription.completed") {
      console.log("\n🎙️ CLIENTE DIJO:", evt.transcript);
    }

    if (evt.type === "error") {
      console.error("❌ ERROR:", evt.error);
    }
  });

  twilioWs.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch (e) { return; }

    if (msg.event === "start") {
      streamSid = msg.start.streamSid;
      console.log("📞 LLAMADA ENTRANTE - ID:", streamSid);
      tryGreet();
    }

    if (msg.event === "media" && oaWs.readyState === WebSocket.OPEN) {
      process.stdout.write("."); // Confirmación de flujo de audio
      oaWs.send(
        JSON.stringify({
          type: "input_audio_buffer.append",
          audio: msg.media.payload,
        })
      );
    }
  });

  twilioWs.on("close", () => {
    console.log("\n🏁 Llamada terminada");
    if (oaWs.readyState === WebSocket.OPEN) oaWs.close();
  });
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml").send(`
<Response>
  <Connect>
    <Stream url="wss://${PUBLIC_BASE_URL}/media-stream" />
  </Connect>
  <Pause length="40"/>
</Response>`);
});

app.get("/", (req, res) => res.send("Domotik Sales Bot Active"));

server.listen(PORT, () => console.log(`🚀 Servidor en puerto ${PORT}`));
