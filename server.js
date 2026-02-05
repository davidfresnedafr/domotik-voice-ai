import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();

// Twilio manda webhooks como application/x-www-form-urlencoded
app.use(express.urlencoded({ extended: false }));

// ✅ Endpoints de prueba / salud
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/healthz", (req, res) => res.status(200).send("OK"));

const server = http.createServer(app);

// ✅ Twilio Media Streams se conecta a este path exacto
const wss = new WebSocketServer({ server, path: "/media-stream" });

wss.on("connection", (ws) => {
  console.log("✅ Twilio connected to Media Stream (/media-stream)");

  ws.on("message", (msg) => {
    // Por ahora solo confirmamos que llegan eventos/audio.
    // Si quieres verlos, descomenta:
    // console.log(msg.toString());
  });

  ws.on("close", () => console.log("ℹ️ Twilio stream closed"));
});

// ✅ Webhook de llamada entrante
app.post("/twilio/voice", (req, res) => {
  console.log("✅ Twilio hit /twilio/voice");

  // PUBLIC_BASE_URL recomendado, si no existe usa el host del request
  const host = process.env.PUBLIC_BASE_URL || req.headers.host;

  res.type("text/xml");
  res.send(
    `
<Response>
  <Say voice="alice" language="en-US">
    Domotik Solutions. Connecting you now.
  </Say>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>
    `.trim()
  );
});

// ✅ Render requiere usar el puerto asignado
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("✅ Server running on port " + PORT);
});
