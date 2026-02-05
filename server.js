import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();

// Twilio manda webhooks como x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

const server = http.createServer(app);

// IMPORTANT: Twilio se conecta a este path exacto
const wss = new WebSocketServer({ server, path: "/media-stream" });

wss.on("connection", (ws) => {
  console.log("✅ Twilio connected to Media Stream (/media-stream)");

  ws.on("message", (msg) => {
    // Aquí luego conectaremos la IA real (OpenAI Realtime)
    // Por ahora solo confirmamos que llega audio/eventos.
    // console.log(msg.toString());
  });

  ws.on("close", () => console.log("ℹ️ Twilio stream closed"));
});

// Webhook que Twilio llama cuando entra una llamada
app.post("/twilio/voice", (req, res) => {
  const host = process.env.PUBLIC_BASE_URL || req.headers.host;

  res.type("text/xml");
  res.send(`
<Response>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>
  `.trim());
});

// ✅ Render requiere escuchar el puerto que te asigna
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("✅ Server running on port " + PORT);
});
