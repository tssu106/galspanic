import { Room, Client } from "@colyseus/core";
import { GameState, Player, Enemy, Projectile, Beam, Item, Missile } from "./schema";
import { GalSim } from "./GalSim";
import type { SimEnemy } from "./GalSim";
import { SIM_MS, PATCH_MS, MOVE_MS, MAX_PLAYERS, IMAGE_POOL, DIRS } from "./constants";
import { verifyToken, recordUnlock } from "./supa";

const COLORS = ["#22d3ee", "#f472b6", "#a3e635", "#fb923c"];

// dev 서버(로컬 npm start)일 때만 클라이언트가 보낸 시작 레벨을 신뢰한다. 프로덕션에서는
// 항상 레벨 1로 시작한다 (임의 레벨 점프 차단).
const DEV = process.env.NODE_ENV !== "production";

export class GameRoom extends Room<GameState> {
  maxClients = MAX_PLAYERS;
  sim!: GalSim;
  private startLevel = 1;   // 이 방이 시작한 레벨 (loss 후 재시작도 이 레벨로 되돌린다)
  private imageSeq: string[] = [];   // 스테이지별 배경 이미지 순서(랜덤 셔플, 한 바퀴 동안 비중복)
  private enemySeq = 0;              // 적 스폰 id 카운터(라운드 넘어가도 재사용 안 함 → 전역 유일)
  private userIds = new Map<string, string>();   // sessionId → Supabase user id (토큰 검증됨). 도감 기록용.

  onCreate(options: { level?: number; private?: boolean } = {}) {
    // dev 에서만 방을 만든 클라이언트가 고른 스테이지로 시작. 그 외에는 레벨 1.
    this.startLevel = DEV ? this.clampLevel(options.level) : 1;
    // "방 만들기"로 만든 방은 비공개 → 빠른 참가(joinOrCreate) 매칭에서 제외, 코드로만 입장.
    if (options.private) this.setPrivate(true);
    this.setState(new GameState());
    // Broadcast state patches at PATCH_MS (~30Hz). Decoupled from the 42Hz sim so the
    // host serializes/sends deltas less often (big CPU/bandwidth win on tiny instances)
    // while physics stays accurate; client interpolation keeps motion smooth.
    this.setPatchRate(PATCH_MS);
    this.sim = new GalSim(this.startLevel);
    this.state.seed = this.sim.gameSeed;   // deterministic seed clients can replay
    this.initGridSchema();
    // 게임을 바로 시작하지 않고 로비에서 대기한다. 4명이 되면 10초 카운트다운 후 시작(아래 tick),
    // 또는 로비의 "지금 시작"으로 시작. startRound 는 시작 시점에 호출한다.
    this.state.phase = "lobby";
    this.state.startIn = -1;   // 시작 카운트다운 남은 초 (-1 = 대기 중)
    // tell clients the authoritative step cadence so their prediction matches exactly
    this.state.moveMs = MOVE_MS;

    // Client sends a held direction code (0..4). Server is authoritative.
    this.onMessage("input", (client, msg: { dir: number; boost?: boolean }) => {
      const d = DIRS[msg?.dir as number] || DIRS[0];
      this.sim.setInput(client.sessionId, [d[0], d[1]]);
      this.sim.setBoost(client.sessionId, !!msg?.boost);
    });

    // 로비 "지금 시작": 4명이 안 돼도 방에 있는 사람들끼리 3초 카운트다운 후 시작.
    this.onMessage("startNow", () => {
      if (this.state.phase === "lobby" && this.state.startIn < 0 && this.state.players.size >= 1) {
        this.state.startIn = 3;
      }
    });

    this.onMessage("restart", () => {
      // On the clear screen, Enter advances to the next stage (no auto-advance, so players
      // can admire the picture as long as they like). On a loss, Enter restarts: prod from
      // level 1, dev from the room's chosen start level so testing stays put.
      if (this.state.phase === "won") this.startRound(this.sim.level + 1);
      else if (this.state.phase === "lost") this.startRound(this.startLevel);
    });

    // dev 전용: 클라이언트의 "보스 소환" 버튼 → 10초 카운트다운 후 보스 등장 (4종 순환).
    this.onMessage("devBoss", () => {
      if (DEV && this.state.phase === "playing") this.sim.scheduleBossDev();
    });
    // dev 전용: "레이저 보스" 버튼 → 레이저 보스를 바로 소환해 곧 레이저 발사 (체험용).
    this.onMessage("devLaser", () => {
      if (DEV && this.state.phase === "playing") this.sim.devLaser();
    });
    // dev 전용: "게임오버 미리보기" 버튼 → 즉시 lost 로 전환해 죽는 화면(3D 카운트다운)을 확인.
    this.onMessage("devLose", () => {
      if (DEV && this.state.phase === "playing") this.state.phase = "lost";
    });
    // dev 전용: "스테이지 완료" 버튼 → 즉시 won 으로 전환해 클리어 화면(그림 리빌)을 확인.
    this.onMessage("devWin", () => {
      if (DEV && this.state.phase === "playing") {
        this.state.phase = "won";
        this.state.nextIn = 0;
        this.state.nextImageId = this.imageAt(this.sim.level + 1);   // 다음 스테이지 그림 미리 로드
        this.grantUnlocks();   // 테스트 클리어도 도감에 기록
      }
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
    // Rebuild the grid arrays wholesale. Colyseus ArraySchema index-assignment
    // (arr[i] = v) is O(N) per set → O(N²) for the whole 160×240×3 grid, i.e. a
    // ~32s freeze at each round start. splice-then-push is O(N) total (~0.6s), so
    // clear each array and repush instead of assigning by index. (see deploy/bench2.js)
    this.state.cells.splice(0, this.state.cells.length);
    this.state.trail.splice(0, this.state.trail.length);
    this.state.web.splice(0, this.state.web.length);
    for (let i = 0; i < this.sim.cellCount; i++) {
      this.state.cells.push(this.sim.grid[i]);
      this.state.trail.push(this.sim.trail[i]);
      this.state.web.push(this.sim.web[i]);
    }
    this.sim.gridDirty.clear();
    this.sim.trailDirty.clear();
    this.sim.webDirty.clear();

    // rebuild enemy + projectile + beam + item + missile schema lists
    this.state.enemies.splice(0, this.state.enemies.length);
    for (const e of this.sim.enemies) this.state.enemies.push(this.makeEnemySchema(e));
    this.state.projectiles.splice(0, this.state.projectiles.length);
    this.state.beams.splice(0, this.state.beams.length);
    this.state.missiles.splice(0, this.state.missiles.length);
    this.state.items.splice(0, this.state.items.length);
    for (const it of this.sim.items) { const s = new Item(); s.x = it.x; s.y = it.y; s.kind = it.kind; this.state.items.push(s); }
    this.state.frozen = 0;

    this.state.level = level;
    this.state.claimedInterior = 0;
    this.state.imageId = this.imageAt(level);   // 랜덤·비중복 배정
    this.state.phase = "playing";
    this.state.nextIn = 0;

    // reflect reset player stats
    this.sim.players.forEach((sp) => {
      const p = this.state.players.get(sp.sessionId);
      if (p) {
        p.x = sp.x; p.y = sp.y; p.lives = sp.lives; p.claimed = 0; p.out = 0;
        p.drawing = 0; p.retreating = 0; p.traps = 0; p.bonus = 0;
      }
    });
  }

  // 로비 → 게임 시작: 라운드를 열고(플레이어 스폰·무적), 방을 잠가 진행 중 방엔 못 들어오게 한다.
  private beginGame() {
    this.state.startIn = -1;
    this.startRound(this.startLevel);   // phase 를 "playing" 으로 전환
    this.lock();                        // 이후 새 플레이어 입장 차단
  }

  private makeEnemySchema(e: SimEnemy): Enemy {
    const es = new Enemy();
    es.x = e.x; es.y = e.y; es.kind = e.kind; es.shape = e.shape; es.r = e.r; es.aim = e.aim;
    return es;
  }

  tick(dt: number) {
    // 로비: 시작 카운트다운을 굴리고, 0이 되면 게임을 시작한다. (그 외엔 시뮬 정지)
    if (this.state.phase === "lobby") {
      if (this.state.startIn >= 0) {
        this.state.startIn = Math.max(0, this.state.startIn - dt / 1000);
        if (this.state.startIn <= 0) this.beginGame();
      }
      return;
    }
    // Stage cleared: stay on the celebration/reveal screen indefinitely so players can
    // enjoy the picture. No auto-advance — a player presses Enter to go on (see "restart").
    if (this.state.phase === "won") return;
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
      p.traps = sp.traps; p.bonus = sp.bonus; p.stamina = sp.stamina;
      p.inv = sp.invuln > 0 ? 1 : 0;   // 무적 표시(마커 희미하게)
    });

    // enemies can grow (reveal spawns) or shrink (captures) — match the list length
    while (this.state.enemies.length < this.sim.enemies.length)
      this.state.enemies.push(this.makeEnemySchema(this.sim.enemies[this.state.enemies.length]));
    while (this.state.enemies.length > this.sim.enemies.length)
      this.state.enemies.pop();
    for (let i = 0; i < this.sim.enemies.length; i++) {
      const se = this.sim.enemies[i]!, es = this.state.enemies[i]!;
      if (se.id == null) se.id = ++this.enemySeq;   // 최초 1회만 스탬프 → 배열이 재정렬돼도 id 유지
      es.id = se.id;
      es.x = se.x; es.y = se.y; es.aim = se.aim;
      es.r = se.r;   // 돌진 시 커진 덩치 등 크기 변화를 매 틱 반영
      // 격노 상태: 0 평상시, 1 격노(추격/질주/난사), 2 devour(포식) — 클라 시각 구분용
      es.enr = (se.boss && se.mode && se.mode !== "normal") ? (se.mode === "devour" ? 2 : 1) : 0;
      es.sh = se.shieldOn ? 1 : 0;   // shielder 무적 표시
      es.st = se.hidden ? 1 : 0;     // phantom 은신 표시
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

    // items: match length + position/kind
    while (this.state.items.length < this.sim.items.length) this.state.items.push(new Item());
    while (this.state.items.length > this.sim.items.length) this.state.items.pop();
    for (let i = 0; i < this.sim.items.length; i++) {
      const si = this.sim.items[i]!, es = this.state.items[i]!;
      es.x = si.x; es.y = si.y; if (es.kind !== si.kind) es.kind = si.kind;
      const b = si.blink ? 1 : 0; if (es.blink !== b) es.blink = b;
    }
    // missiles: match length + position
    while (this.state.missiles.length < this.sim.missiles.length) this.state.missiles.push(new Missile());
    while (this.state.missiles.length > this.sim.missiles.length) this.state.missiles.pop();
    for (let i = 0; i < this.sim.missiles.length; i++) {
      const sm = this.sim.missiles[i]!, es = this.state.missiles[i]!; es.x = sm.x; es.y = sm.y;
    }
    this.state.frozen = this.sim.freezeT > 0 ? 1 : 0;

    // broadcast capture events for client popups/sound, then clear
    if (this.sim.captureEvents.length) {
      for (const ev of this.sim.captureEvents) this.broadcast("trap", ev);
      this.sim.captureEvents.length = 0;
    }
    // 아이템 획득 연출 이벤트
    if (this.sim.itemEvents.length) {
      for (const ev of this.sim.itemEvents) this.broadcast("item", ev);
      this.sim.itemEvents.length = 0;
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
        this.state.nextIn = 0;   // no countdown — wait for a player's Enter
        // publish the next stage's image now so clients can preload it while admiring this one
        this.state.nextImageId = this.imageAt(this.sim.level + 1);
        this.grantUnlocks();   // 서버 권위: 실제 클리어했을 때만 도감 기록
      }
    }
  }

  // 서버 권위 도감 기록: 방에 있는 로그인 플레이어 전원에게 현재 스테이지 그림을 unlock.
  // (클라이언트는 DB 쓰기 권한이 없어 위조 불가 — RLS 로 막힘)
  private grantUnlocks() {
    const imageId = this.state.imageId;
    if (!imageId) return;
    for (const uid of this.userIds.values()) recordUnlock(uid, imageId);
  }

  // 클라이언트가 보낸 레벨을 1..99 정수로 정규화. 유효하지 않으면 1.
  private clampLevel(v: unknown): number {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.min(99, n));
  }

  // 스테이지 배경 이미지를 랜덤 순서로 배정하되, 풀(IMAGE_POOL) 한 바퀴 동안은 겹치지 않게 한다.
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

  onJoin(client: Client, options: { name?: string; token?: string }) {
    const slot = this.freeSlot();
    const sp = this.sim.addPlayer(client.sessionId, slot);

    const p = new Player();
    p.id = client.sessionId;
    p.name = options?.name || `P${slot}`;
    p.color = COLORS[(slot - 1) % COLORS.length];
    p.owner = slot;
    p.x = sp.x; p.y = sp.y; p.lives = sp.lives;
    this.state.players.set(client.sessionId, p);

    // 로그인 토큰 검증(비동기) → 성공하면 도감 기록 대상에 등록. 위조 토큰은 무시된다.
    if (options?.token) {
      verifyToken(options.token).then((uid) => {
        if (uid && this.state.players.has(client.sessionId)) this.userIds.set(client.sessionId, uid);
      });
    }

    // 로비가 꽉 차면(4명) 10초 카운트다운 후 자동 시작.
    if (this.state.phase === "lobby" && this.state.startIn < 0 && this.state.players.size >= MAX_PLAYERS) {
      this.state.startIn = 10;
    }
  }

  onLeave(client: Client) {
    this.sim.removePlayer(client.sessionId);
    this.state.players.delete(client.sessionId);
    this.userIds.delete(client.sessionId);
  }
}
