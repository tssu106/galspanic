import { Room, Client } from "@colyseus/core";
import { GameState, Player, Enemy, Projectile, Beam } from "./schema";
import { GalSim } from "./GalSim";
import type { SimEnemy } from "./GalSim";
import { SIM_MS, PATCH_MS, MOVE_MS, MAX_PLAYERS, IMAGE_POOL, DIRS, WIN_COUNTDOWN_MS } from "./constants";

const COLORS = ["#22d3ee", "#f472b6", "#a3e635", "#fb923c"];

// dev 서버(로컬 npm start)일 때만 클라이언트가 보낸 시작 레벨을 신뢰한다. 프로덕션에서는
// 항상 레벨 1로 시작한다 (임의 레벨 점프 차단).
const DEV = process.env.NODE_ENV !== "production";

export class GameRoom extends Room<GameState> {
  maxClients = MAX_PLAYERS;
  sim!: GalSim;
  private wonElapsed = 0;   // ms accumulated on the between-stage win countdown
  private startLevel = 1;   // 이 방이 시작한 레벨 (loss 후 재시작도 이 레벨로 되돌린다)
  private imageSeq: string[] = [];   // 스테이지별 배경 이미지 순서(랜덤 셔플, 한 바퀴 동안 비중복)

  onCreate(options: { level?: number } = {}) {
    // dev 에서만 방을 만든 클라이언트가 고른 스테이지로 시작. 그 외에는 레벨 1.
    this.startLevel = DEV ? this.clampLevel(options.level) : 1;
    this.setState(new GameState());
    // Broadcast state patches at PATCH_MS (~90Hz) instead of the 50ms/20Hz default.
    // Decoupled from the faster sim so bandwidth stays bounded while input stays fresh.
    this.setPatchRate(PATCH_MS);
    this.sim = new GalSim(this.startLevel);
    this.state.seed = this.sim.gameSeed;   // deterministic seed clients can replay
    this.initGridSchema();
    this.startRound(this.startLevel);
    // tell clients the authoritative step cadence so their prediction matches exactly
    this.state.moveMs = MOVE_MS;

    // Client sends a held direction code (0..4). Server is authoritative.
    this.onMessage("input", (client, msg: { dir: number; boost?: boolean }) => {
      const d = DIRS[msg?.dir as number] || DIRS[0];
      this.sim.setInput(client.sessionId, [d[0], d[1]]);
      this.sim.setBoost(client.sessionId, !!msg?.boost);
    });

    this.onMessage("restart", () => {
      // A win auto-advances via the between-stage countdown (no instant skip);
      // only a loss restarts when a player hits Enter. Prod restarts from level 1;
      // in dev we return to the room's chosen start level so testing stays put.
      if (this.state.phase === "lost") this.startRound(this.startLevel);
    });

    // dev 전용: 클라이언트의 "보스 소환" 버튼 → 10초 카운트다운 후 보스 등장 (4종 순환).
    this.onMessage("devBoss", () => {
      if (DEV && this.state.phase === "playing") this.sim.scheduleBossDev();
    });

    // Chat: relay a short message to everyone as a speech bubble over the sender.
    this.onMessage("chat", (client, msg: { text?: string }) => {
      const text = String(msg?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (!text) return;
      const sp = this.sim.players.find((p) => p.sessionId === client.sessionId);
      if (sp) this.broadcast("chat", { owner: sp.owner, text });
    });

    // Authoritative simulation loop (fast, decoupled from the broadcast rate).
    this.setSimulationInterval((dt) => this.tick(dt), SIM_MS);
  }

  private initGridSchema() {
    this.state.cells = new (this.state.cells.constructor as any)();
    this.state.trail = new (this.state.trail.constructor as any)();
    this.state.web = new (this.state.web.constructor as any)();
    for (let i = 0; i < this.sim.cellCount; i++) {
      this.state.cells.push(this.sim.grid[i]);
      this.state.trail.push(this.sim.trail[i]);
      this.state.web.push(this.sim.web[i]);
    }
    this.state.totalInterior = this.sim.totalInterior;
  }

  startRound(level: number) {
    this.sim.resetRound(level);
    // push full grid once (dirty sets already hold every changed cell, but be explicit)
    for (let i = 0; i < this.sim.cellCount; i++) {
      this.state.cells[i] = this.sim.grid[i];
      this.state.trail[i] = this.sim.trail[i];
      this.state.web[i] = this.sim.web[i];
    }
    this.sim.gridDirty.clear();
    this.sim.trailDirty.clear();
    this.sim.webDirty.clear();

    // rebuild enemy + projectile + beam schema lists
    this.state.enemies.splice(0, this.state.enemies.length);
    for (const e of this.sim.enemies) this.state.enemies.push(this.makeEnemySchema(e));
    this.state.projectiles.splice(0, this.state.projectiles.length);
    this.state.beams.splice(0, this.state.beams.length);

    this.state.level = level;
    this.state.claimedInterior = 0;
    this.state.imageId = this.imageAt(level);   // 랜덤·비중복 배정
    this.state.phase = "playing";
    this.state.nextIn = 0;
    this.wonElapsed = 0;

    // reflect reset player stats
    this.sim.players.forEach((sp) => {
      const p = this.state.players.get(sp.sessionId);
      if (p) {
        p.x = sp.x; p.y = sp.y; p.lives = sp.lives; p.claimed = 0; p.out = 0;
        p.drawing = 0; p.retreating = 0; p.traps = 0; p.bonus = 0;
      }
    });
  }

  private makeEnemySchema(e: SimEnemy): Enemy {
    const es = new Enemy();
    es.x = e.x; es.y = e.y; es.kind = e.kind; es.shape = e.shape; es.r = e.r; es.aim = e.aim;
    return es;
  }

  tick(dt: number) {
    // between-stage countdown: after clearing, auto-advance to the next stage over ~5s
    if (this.state.phase === "won") {
      this.wonElapsed += dt;
      this.state.nextIn = Math.max(0, (WIN_COUNTDOWN_MS - this.wonElapsed) / 1000);
      if (this.wonElapsed >= WIN_COUNTDOWN_MS) this.startRound(this.sim.level + 1);
      return;
    }
    if (this.state.phase !== "playing") return;
    this.sim.update(dt / 1000);

    // sync only changed cells
    for (const i of this.sim.gridDirty) this.state.cells[i] = this.sim.grid[i];
    for (const i of this.sim.trailDirty) this.state.trail[i] = this.sim.trail[i];
    for (const i of this.sim.webDirty) this.state.web[i] = this.sim.web[i];
    this.sim.gridDirty.clear();
    this.sim.trailDirty.clear();
    this.sim.webDirty.clear();

    // sync players
    this.sim.players.forEach((sp) => {
      const p = this.state.players.get(sp.sessionId);
      if (!p) return;
      p.x = sp.x; p.y = sp.y;
      p.drawing = sp.drawing ? 1 : 0;
      p.retreating = sp.retreating ? 1 : 0;
      p.boosting = sp.boosting ? 1 : 0;
      p.lives = sp.lives; p.claimed = sp.claimed; p.out = sp.out ? 1 : 0;
      p.traps = sp.traps; p.bonus = sp.bonus;
      p.inv = sp.invuln > 0 ? 1 : 0;   // 무적 표시(마커 희미하게)
    });

    // enemies can grow (reveal spawns) or shrink (captures) — match the list length
    while (this.state.enemies.length < this.sim.enemies.length)
      this.state.enemies.push(this.makeEnemySchema(this.sim.enemies[this.state.enemies.length]));
    while (this.state.enemies.length > this.sim.enemies.length)
      this.state.enemies.pop();
    for (let i = 0; i < this.sim.enemies.length; i++) {
      const se = this.sim.enemies[i]!, es = this.state.enemies[i]!;
      es.x = se.x; es.y = se.y; es.aim = se.aim;
      es.r = se.r;   // 돌진 시 커진 덩치 등 크기 변화를 매 틱 반영
      // 격노 상태: 0 평상시, 1 격노(추격/질주/난사), 2 devour(포식) — 클라 시각 구분용
      es.enr = (se.boss && se.mode && se.mode !== "normal") ? (se.mode === "devour" ? 2 : 1) : 0;
      if (es.kind !== se.kind) { es.kind = se.kind; es.shape = se.shape; }
    }

    // projectiles: match length and copy positions
    while (this.state.projectiles.length < this.sim.projectiles.length)
      this.state.projectiles.push(new Projectile());
    while (this.state.projectiles.length > this.sim.projectiles.length)
      this.state.projectiles.pop();
    for (let i = 0; i < this.sim.projectiles.length; i++) {
      const sp = this.sim.projectiles[i]!, ps = this.state.projectiles[i]!;
      ps.x = sp.x; ps.y = sp.y;
    }

    // beams: match length and copy endpoints/state
    while (this.state.beams.length < this.sim.beams.length) this.state.beams.push(new Beam());
    while (this.state.beams.length > this.sim.beams.length) this.state.beams.pop();
    for (let i = 0; i < this.sim.beams.length; i++) {
      const sb = this.sim.beams[i]!, es = this.state.beams[i]!;
      const [ax, ay, bx, by] = this.sim.beamEnds(sb);   // full 이면 양방향 관통 라인
      es.x1 = ax; es.y1 = ay; es.x2 = bx; es.y2 = by;
      es.w = sb.w; es.on = sb.tele > 0 ? 0 : 1;
    }

    // broadcast capture events for client popups/sound, then clear
    if (this.sim.captureEvents.length) {
      for (const ev of this.sim.captureEvents) this.broadcast("trap", ev);
      this.sim.captureEvents.length = 0;
    }

    // 블랙홀 예고 이벤트 → 클라이언트가 그 자리에 블랙홀을 띄워 회피를 유도
    if (this.sim.warpEvents.length) {
      for (const ev of this.sim.warpEvents) this.broadcast("warp", ev);
      this.sim.warpEvents.length = 0;
    }

    this.state.claimedInterior = this.sim.claimedInterior;
    this.state.bossIn = this.sim.bossIn;   // 보스 카운트다운 (≤10s면 클라가 WARNING 표시)
    if (this.sim.over) {
      this.state.phase = this.sim.over;   // "won" | "lost"
      if (this.sim.over === "won") {
        this.wonElapsed = 0;
        this.state.nextIn = WIN_COUNTDOWN_MS / 1000;
        // publish the next stage's image now so clients can preload it during the countdown
        this.state.nextImageId = this.imageAt(this.sim.level + 1);
      }
    }
  }

  // 클라이언트가 보낸 레벨을 1..99 정수로 정규화. 유효하지 않으면 1.
  private clampLevel(v: unknown): number {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.min(99, n));
  }

  // 스테이지 배경 이미지를 랜덤 순서로 배정하되, 풀(37장)을 한 바퀴 도는 동안은 겹치지 않게 한다.
  // 소진되면 다시 셔플해 이어 붙이고, 이음새에서 직전 이미지와 연속으로 겹치지 않도록 한다.
  private imageAt(level: number): string {
    while (this.imageSeq.length < level) {
      const pool = IMAGE_POOL.slice();
      for (let i = pool.length - 1; i > 0; i--) {   // Fisher-Yates 셔플
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      const last = this.imageSeq[this.imageSeq.length - 1];   // 이음새 연속 중복 방지
      if (last && pool.length > 1 && pool[0] === last) [pool[0], pool[1]] = [pool[1], pool[0]];
      this.imageSeq.push(...pool);
    }
    return this.imageSeq[level - 1];
  }

  private freeSlot(): number {
    const used = new Set<number>();
    this.sim.players.forEach((p) => used.add(p.owner));
    for (let s = 1; s <= MAX_PLAYERS; s++) if (!used.has(s)) return s;
    return 1;
  }

  onJoin(client: Client, options: { name?: string }) {
    const slot = this.freeSlot();
    const sp = this.sim.addPlayer(client.sessionId, slot);

    const p = new Player();
    p.id = client.sessionId;
    p.name = options?.name || `P${slot}`;
    p.color = COLORS[(slot - 1) % COLORS.length];
    p.owner = slot;
    p.x = sp.x; p.y = sp.y; p.lives = sp.lives;
    this.state.players.set(client.sessionId, p);
  }

  onLeave(client: Client) {
    this.sim.removePlayer(client.sessionId);
    this.state.players.delete(client.sessionId);
  }
}
