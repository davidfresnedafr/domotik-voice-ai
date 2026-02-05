import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
app.use(express.urlencoded({ extended: false }));

// ✅ LOG de TODAS las requests
app.use((req, res, next) => {
  console.log(`➡️ ${req.method} ${req.path}`);
  next();
});

// ✅ Endpoints de prueba
app.get("/", (req, res) => res.status(200).send("OK"));
app.get("/healthz", (req, res) => res.status(200).send("OK"));

// ✅ Endpoint de prueba para ver logs sin Twilio
app.get("/twilio/voice", (req, res) => {
  res.status(200).send("VOICE ENDPOINT OK (GET)");
});

const server = http.createServer(app);

// ✅ Media Stream path
const wss = new WebSocketServer({ server, path: "/media-stream" });

wss.on("connection", (ws) => {
  console.log("✅ WS CONNECTED: /media-stream");
  ws.on("message", () => {});
  ws.on("close", () => console.log("ℹ️ WS CLOSED"));
});

// ✅ Twilio webhook real (POST)
app.post("/twilio/voice", (req, res) => {
  console.log("✅ TWILIO POST /twilio/voice HIT");

  const host = process.env.PUBLIC_BASE_URL || req.headers.host;

  res.type("text/xml");
  res.send(`
<Response>
  <Say voice="alice" language="en-US">Domotik Solutions. Connecting you now.</Say>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>
  `.trim());
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log("✅ Server running on port " + PORT);
});

