import http from "http";
import path from "path";
import express from "express";
import { Server, matchMaker } from "@colyseus/core";
import { WebSocketTransport } from "@colyseus/ws-transport";
import { GameRoom } from "./GameRoom";
import { IMAGE_POOL } from "./constants";

const port = Number(process.env.PORT || 2567);
const host = process.env.HOST || "0.0.0.0"; // bind all interfaces so LAN/tunnel clients can reach us
// dev 서버 여부: 로컬 `npm start`(NODE_ENV 미설정)는 dev, 배포(NODE_ENV=production)는 아님.
// dev 일 때만 클라이언트에 스테이지 선택 UI를 노출하고, 서버가 선택 레벨을 신뢰한다.
const DEV = process.env.NODE_ENV !== "production";
const app = express();
app.use(express.json());

// Serve the online client from this same server → single origin, single port.
// This makes one tunnel (e.g. `ngrok http 2567`) enough for external players:
// they open the tunnel URL and the page connects back over the same origin.
app.use(express.static(path.join(__dirname, "..", "..", "client"), {
  setHeaders: (res, filePath) => {
    const p = filePath.replace(/\\/g, "/");
    // Vendored libraries (e.g. three.js) rarely change and are large — cache them a week.
    if (p.includes("/vendor/")) { res.setHeader("Cache-Control", "public, max-age=604800"); return; }
    // The client (HTML + bundled sim) changes on every deploy. Don't let browsers pin an old
    // copy — that's how a stale UI (e.g. the removed clear-countdown) keeps showing after an
    // update. Force a revalidate for html/js so players always get the freshly deployed client.
    if (/\.(html|js)$/i.test(p))
      res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
  },
}));

// NOTE: In production, serve only a BLURRED/low-res version of images here.
// The full-resolution original must never be sent to the client wholesale —
// otherwise players can read it straight from browser devtools.
// For the prototype, put blurred images under ./public/images/<imageId>_blur.jpg
// Allow the (separately-served) client origin to read images onto the canvas.
app.use("/images", (_req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  next();
});
// 실행 위치(cwd)와 무관하게 항상 server/public/images 를 서빙 (systemd 등에서 WorkingDirectory 가 달라도 안전).
app.use("/images", express.static(path.join(__dirname, "..", "public", "images")));

app.get("/health", (_req, res) => res.json({ ok: true }));
// 클라이언트가 시작 화면에서 이 값을 읽어 dev 전용 스테이지 선택 UI 노출 여부를 정한다.
app.get("/config", (_req, res) => res.json({ dev: DEV, imageCount: IMAGE_POOL.length }));
// 현재 접속자 수(모든 game 방 합산)와 방 개수 — 메인화면에 표시.
app.get("/stats", async (_req, res) => {
  try {
    const rooms = await matchMaker.query({ name: "game" });
    const online = rooms.reduce((s, r) => s + (r.clients || 0), 0);
    res.json({ online, rooms: rooms.length });
  } catch {
    res.json({ online: 0, rooms: 0 });
  }
});

const server = http.createServer(app);
const gameServer = new Server({
  transport: new WebSocketTransport({ server }),
});

gameServer.define("game", GameRoom);

gameServer.listen(port, host);
console.log(`[galspanic] listening on http://localhost:${port}  (bind ${host}:${port})`);
console.log(`[galspanic] open the online client at http://localhost:${port}/index.html`);
