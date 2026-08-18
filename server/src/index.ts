import http from "http";
import path from "path";
import express from "express";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { GameRoom } from "./GameRoom";

const port = Number(process.env.PORT || 2567);
const host = process.env.HOST || "0.0.0.0"; // bind all interfaces so LAN/tunnel clients can reach us
const app = express();
app.use(express.json());

// Serve the online client from this same server → single origin, single port.
// This makes one tunnel (e.g. `ngrok http 2567`) enough for external players:
// they open the tunnel URL and the page connects back over the same origin.
app.use(express.static(path.join(__dirname, "..", "..", "client")));

// NOTE: In production, serve only a BLURRED/low-res version of images here.
// The full-resolution original must never be sent to the client wholesale —
// otherwise players can read it straight from browser devtools.
// For the prototype, put blurred images under ./public/images/<imageId>_blur.jpg
// Allow the (separately-served) client origin to read images onto the canvas.
app.use("/images", (_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  next();
});
app.use("/images", express.static("public/images"));

app.get("/health", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server }),
});

gameServer.define("game", GameRoom);

gameServer.listen(port, host);
console.log(`[galspanic] listening on http://localhost:${port}  (bind ${host}:${port})`);
console.log(`[galspanic] open the online client at http://localhost:${port}/index.html`);
