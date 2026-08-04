import http from "http";
import express from "express";
import { Server } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { GameRoom } from "./GameRoom";

const port = Number(process.env.PORT || 2567);
const app = express();
app.use(express.json());

// NOTE: In production, serve only a BLURRED/low-res version of images here.
// The full-resolution original must never be sent to the client wholesale —
// otherwise players can read it straight from browser devtools.
// For the prototype, put blurred images under ./public/images/<imageId>_blur.jpg
app.use("/images", express.static("public/images"));

app.get("/health", (_req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server }),
});

gameServer.define("game", GameRoom);

gameServer.listen(port);
console.log(`[galspanic] listening on ws://localhost:${port}`);
