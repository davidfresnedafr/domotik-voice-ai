import express from "express";
import http from "http";
import WebSocket, { WebSocketServer } from "ws";

const app = express();
const server = http.createServer(app);

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("Twilio connected to Media Stream");

  ws.on("message", (msg) => {
    // Aquí luego conectaremos la IA real
  });

  ws.send(JSON.stringify({
    event: "media",
    media: {
      payload: ""
    }
  }));
});

app.post("/twilio/voice", (req, res) => {
  res.type("text/xml");
  res.send(`
    <Response>
      <Connect>
        <Stream url="wss://${process.env.PUBLIC_BASE_URL}/media-stream" />
      </Connect>
    </Response>
  `);
});

server.listen(3000, () => {
  console.log("Server running on port 3000");
});
