import express from "express";
import http from "http";
import { WebSocketServer } from "ws";

const app = express();
app.use(express.urlencoded({ extended: false }));

app.use((req, _res, next) => {
  console.log(`➡️ ${req.method} ${req.path}`);
  next();
});

app.get("/", (_req, res) => res.status(200).send("OK"));
app.get("/healthz", (_req, res) => res.status(200).send("OK"));

const server = http.createServer(app);

// Twilio Media Streams se conecta aquí
const wss = new WebSocketServer({ server, path: "/media-stream" });

wss.on("connection", (ws) => {
  console.log("✅ Twilio connected to /media-stream");

  ws.on("message", (msg) => {
    // console.log(msg.toString()); // debug
  });

  ws.on("close", () => console.log("ℹ️ Twilio stream closed"));
});

// Webhook de llamada entrante (TwiML)
app.post("/twilio/voice", (req, res) => {
  console.log("✅ Twilio hit /twilio/voice");

  const host = process.env.PUBLIC_BASE_URL || req.headers.host;

  res.type("text/xml");
  res.send(
    `
<Response>
  <Say voice="alice" language="en-US">Domotik Solutions. Connecting you now.</Say>
  <Connect>
    <Stream url="wss://${host}/media-stream" />
  </Connect>
</Response>
    `.trim()
  );
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("✅ Server running on port " + PORT));
