import { GRID_W, GRID_H, BORDER as B, CLEAR_RATIO, MOVE_MS, START_LIVES, BOOST_MULT, BOOST_COST, START_REVEAL_RATIO } from "./constants";

const COLS = GRID_W, ROWS = GRID_H, N = COLS * ROWS;
const EMPTY = 0, CLAIMED = 1;
const idx = (x: number, y: number) => y * COLS + x;
const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < COLS && y < ROWS;

// Seeded PRNG (mulberry32). Replaces Math.random so the whole sim is reproducible
// from a single seed — the foundation for a client running the same sim (prediction)
// or for deterministic lockstep. Given the seed + the same inputs, every machine
// produces identical results.
function mulberry32(a: number): () => number {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// tuning (mirrors client/local.html, scaled for the 64x64 online grid)
const STALL_MS = 400;      // stop moving mid-draw this long -> the line retraces
const RETRACE_MS = 16;     // ms per cell while retracing back to origin (faster than MOVE_MS)
const TRAP_RATIO = 0.10;   // an enemy boxed into a region <=10% of interior is captured
// 포획 점수 — 몬스터 등급(kind)별 차등. 더 위험하고/드물고/높은 레벨에 나오는 적일수록 높다.
// 한 번의 포획으로 잡힌 모든 적의 점수를 합산해 지급한다. 이 점수는 Shift 질주로 소모된다.
const CAPTURE_SCORE: Record<string, number> = {
  star:   150,   // 기본 반사체 (흔함, Lv1+)
  saw:    200,   // 빠른 반사체 (Lv1+)
  blob:   250,   // 느린 방황 (Lv2+)
  ghost:  300,   // 예측불가 방황 (Lv2+)
  dart:   500,   // 빠른 추적자 (Lv3+)
  gunner: 700,   // 원거리 포수 (Lv4+, 최고 등급)
  // 보스: 덩치 크고 다방향 난사. 포획 시 큰 점수.
  boss_ring:   2500,
  boss_spiral: 3200,
  boss_spread: 3600,
  boss_cross:  2800,
};
const CAPTURE_SCORE_DEFAULT = 200;   // 미등록 종류에 대한 안전값
const BULLET_SPEED = 20;   // cells/sec for gunner projectiles
const BULLET_LIFE = 4;     // seconds
const TAU2 = Math.PI * 2;

// ── 보스 몬스터 ──────────────────────────────────────────────────────────────
// 라운드 시작 후 일정 시간이 지나면 등장하는 거대·다방향 발사 몬스터. 한 라운드에 최대 4마리
// (종류별 1마리)까지, 시간 간격을 두고 순차 등장한다. 일반 적처럼 "가두면 포획"으로 잡는다.
const BOSS_BULLET_SPEED = 13;   // 다방향이라 개별 탄속은 일반(20)보다 느리게
const BOSS_FIRST_SEC = 120;     // 라운드 시작 후 첫 보스까지 (초) — 2분
const BOSS_INTERVAL_SEC = 120;  // 이후 보스 등장 간격 (초) — 2분마다 한 마리씩 무한 등장
const MAX_PROJECTILES = 500;    // 안전 상한 (보스 난사 폭주 방지)
// 블랙홀 출현: 보스는 즉시 생기지 않고, 먼저 이 시간 동안 블랙홀이 "예고"로 자란다(회피 시간).
// 예고가 끝나면 그 원형 범위의 점유지를 지우고(원상복구), 범위 안 플레이어를 죽이며 보스가 튀어나온다.
const BOSS_WARP_SEC = 1.8;      // 블랙홀 예고 지속(초) — 클라 WARP_TELE_MS 와 맞춘다 (회피 시간)
const BOSS_WARP_ERASE_R = 9;    // 블랙홀이 지우는/죽이는 원형 반경(셀)
const BOSS_MAX_ALIVE = 3;       // 동시에 존재할 수 있는 보스 최대 수

type BossPattern = "radial" | "spiral" | "spread" | "cross";
interface BossType {
  key: string; shape: string; behavior: Behavior; pattern: BossPattern;
  speed: number;      // enemySpeed 배율 (보스는 느긋하게)
  r: number;          // 반지름 (일반 적 ~2.2 대비 큰 덩치)
  bullets: number;    // 한 번의 발사 탄 수
  fireEvery: number;  // 발사 간격(초)
  score: number;      // 포획 점수
}
const BOSS_TYPES: BossType[] = [
  { key: "boss_ring",   shape: "boss_ring",   behavior: "bounce", pattern: "radial", speed: 0.35, r: 6.0, bullets: 16, fireEvery: 2.0, score: 2500 },
  { key: "boss_spiral", shape: "boss_spiral", behavior: "wander", pattern: "spiral", speed: 0.30, r: 5.5, bullets: 5,  fireEvery: 0.32, score: 3200 },
  { key: "boss_spread", shape: "boss_spread", behavior: "hunt",   pattern: "spread", speed: 0.50, r: 5.0, bullets: 7,  fireEvery: 1.5, score: 3600 },
  { key: "boss_cross",  shape: "boss_cross",  behavior: "bounce", pattern: "cross",  speed: 0.40, r: 5.5, bullets: 8,  fireEvery: 1.1, score: 2800 },
];

type Behavior = "bounce" | "wander" | "hunt" | "turret";
interface EnemyType {
  key: string; speed: number; behavior: Behavior; shape: string;
  minLevel: number; weight: number; gun?: boolean; fireEvery?: number;
}
// speed is a multiplier on the level's base enemySpeed; size derives from speed.
const ENEMY_TYPES: EnemyType[] = [
  { key: "star",   speed: 1.00, behavior: "bounce", shape: "star",     minLevel: 1, weight: 3 },
  { key: "saw",    speed: 1.15, behavior: "bounce", shape: "saw",      minLevel: 1, weight: 2 },
  { key: "blob",   speed: 0.70, behavior: "wander", shape: "blob",     minLevel: 2, weight: 2 },
  { key: "ghost",  speed: 0.90, behavior: "wander", shape: "ghost",    minLevel: 2, weight: 1 },
  { key: "gunner", speed: 0.55, behavior: "turret", shape: "turret",   minLevel: 4, weight: 2, gun: true, fireEvery: 2.4 },
  { key: "dart",   speed: 1.55, behavior: "hunt",   shape: "triangle", minLevel: 3, weight: 2 },
];

export interface SimPlayer {
  sessionId: string;
  owner: number;             // 1-based slot, equals trail cell value
  x: number; y: number;
  spawnX: number; spawnY: number;
  heldDir: [number, number] | null;
  boost: boolean;            // Shift held (sprint requested)
  boosting: boolean;         // actually sprinting this tick (requested + moving + can afford)
  drawing: boolean;
  retreating: boolean;
  lives: number;
  claimed: number;
  traps: number;             // monsters captured
  bonus: number;             // capture bonus points
  out: boolean;
  acc: number;               // ms accumulator for the move timer
  idle: number;              // ms stalled while drawing (triggers retrace)
  drawOriginX: number; drawOriginY: number;  // safe cell a line started from
  trailCells: number[];
}

export interface SimEnemy {
  x: number; y: number; vx: number; vy: number;
  kind: string; shape: string; behavior: Behavior; speed: number; r: number;
  spin: number; wanderT: number;
  gun: boolean; fireEvery: number; cooldown: number; aim: number;
  boss?: boolean; pattern?: BossPattern; bullets?: number; phase?: number;   // 보스 전용
  // 보스 행동 모드: 주기적으로 "격노"(추격/질주/난사)로 전환했다가 평상시로 복귀.
  mode?: string; modeT?: number; baseSpeed?: number; fireEveryBase?: number; behaviorSaved?: Behavior; baseR?: number; rTarget?: number;
}

export interface SimProjectile { x: number; y: number; vx: number; vy: number; life: number; r: number; }
export interface CaptureEvent { x: number; y: number; count: number; bonus: number; owner: number; }
export interface BossEvent { x: number; y: number; kind: string; }   // 보스 출현 (클라 연출용)

/**
 * Authoritative Qix-style simulation. DOM-free; a faithful port of the local
 * engine (client/local.html): 6 monster archetypes, gunner projectiles,
 * capture/trap rule, retrace-on-stall, and frontier-only movement.
 */
export class GalSim {
  grid = new Uint8Array(N);
  trail = new Uint8Array(N);
  players: SimPlayer[] = [];
  enemies: SimEnemy[] = [];
  projectiles: SimProjectile[] = [];
  captureEvents: CaptureEvent[] = [];   // drained by the room, broadcast to clients
  warpEvents: BossEvent[] = [];         // 블랙홀 예고 시작 이벤트 (룸이 drain → "warp" 브로드캐스트)
  // 예고 중인 블랙홀들. 타이머가 끝나면 맵을 원형으로 지우고 플레이어를 죽인 뒤 보스를 생성한다.
  private pendingWarps: { x: number; y: number; type: BossType; t: number }[] = [];
  roundElapsed = 0;                     // 라운드 경과 시간(초)
  bossIn = -1;                          // 다음 보스까지 남은 시간(초). -1 = 더 없음 (클라 카운트다운용)
  private bossTimer = 0;                // 다음 보스까지 남은 시간(초)
  private bossQueue: BossType[] = [];   // 이번 라운드에 아직 등장하지 않은 보스들
  private devBossIdx = 0;               // dev 즉시 소환 시 순환 인덱스
  level = 1;
  totalInterior = (COLS - 2 * B) * (ROWS - 2 * B);
  claimedInterior = 0;
  revealX = 0; revealY = 0;   // center of the round-start bright zone; anchors (re)spawns
  over: null | "won" | "lost" = null;
  enemySpeed = 8;
  spawnThresholds: number[] = [];

  // seeded RNG: one game seed (the only real randomness), re-seeded per round from
  // it + the level. Exposed so clients can run the same deterministic sim.
  gameSeed = (Math.random() * 0x100000000) >>> 0;
  private rng: () => number = mulberry32(1);   // replaced per round in resetRound

  // change tracking so the room only syncs cells that actually changed
  gridDirty = new Set<number>();
  trailDirty = new Set<number>();

  constructor(level = 1) { this.resetRound(level); }

  get ratio() { return this.claimedInterior / this.totalInterior; }
  get cellCount() { return N; }

  private setGrid(i: number, v: number) {
    if (this.grid[i] !== v) { this.grid[i] = v; this.gridDirty.add(i); }
  }
  private setTrail(i: number, v: number) {
    if (this.trail[i] !== v) { this.trail[i] = v; this.trailDirty.add(i); }
  }

  resetRound(level: number) {
    this.level = level;
    // re-seed deterministically from the game seed + level (before any this.rng() use)
    this.rng = mulberry32((this.gameSeed ^ Math.imul(level, 0x9E3779B1)) >>> 0);
    this.over = null;
    this.claimedInterior = 0;
    this.projectiles = [];
    this.captureEvents = [];
    this.warpEvents = [];
    this.pendingWarps = [];
    // 보스 스케줄 초기화: 일정 시간 후 종류별로 한 마리씩 순차 등장 (순서는 라운드마다 랜덤)
    this.roundElapsed = 0;
    this.bossTimer = BOSS_FIRST_SEC;
    this.bossQueue = this.shuffledBosses();
    for (let i = 0; i < N; i++) { this.setGrid(i, EMPTY); this.setTrail(i, 0); }
    for (let y = 0; y < ROWS; y++)
      for (let x = 0; x < COLS; x++)
        if (x < B || y < B || x >= COLS - B || y >= ROWS - B) this.setGrid(idx(x, y), CLAIMED);

    // 시작 시 내부의 랜덤 위치를 5%가량 밝힌다(안전지대). 플레이어는 이 구역에서 시작한다.
    this.revealStartArea();

    for (const p of this.players) {
      const [sx, sy] = this.pickSafeSpawn(this.revealX, this.revealY);   // 밝은 구역 위에서 시작
      p.x = sx; p.y = sy; p.spawnX = sx; p.spawnY = sy;
      p.drawing = false; p.retreating = false; p.out = false; p.lives = START_LIVES;
      p.boost = false; p.boosting = false;
      p.claimed = 0; p.traps = 0; p.bonus = 0; p.acc = 0; p.idle = 0;
      p.drawOriginX = sx; p.drawOriginY = sy; p.trailCells.length = 0;
    }

    this.enemies = [];
    this.enemySpeed = 18 + (level - 1) * 3.6;  // cells per second (2x the old base+ramp, test)
    this.spawnThresholds = [0.20, 0.40, 0.60];
    const active = Math.max(1, this.players.length);
    const count = 4 + active * 2 + (level - 1) * 2;   // more monsters to populate the larger map
    for (let i = 0; i < count; i++) {
      // spread across most of the interior; keep them off the just-revealed bright zone
      const [ex, ey] = this.randomEmptySpot();
      this.enemies.push(this.makeEnemy(ex, ey));
    }
  }

  // 라운드 시작용 안전지대: 내부의 랜덤 위치에 START_REVEAL_RATIO 만큼 직사각형으로 밝힌다.
  // revealX/Y(재생성 기준점)를 설정하고 claimedInterior 를 그만큼 올린다.
  private revealStartArea() {
    const iw = COLS - 2 * B, ih = ROWS - 2 * B;
    // 크기(넓이)도 랜덤, 형태(가로세로 비율)도 랜덤. 넓이는 내부의 약 3%~7.5% 사이에서
    // 무작위로 정하고, 비율은 0.35~2.8로 넓게 잡아 길쭉한 직사각형도 나오게 한다.
    const ratio = START_REVEAL_RATIO * (0.6 + this.rng() * 0.9);   // ~3% ~ 7.5%
    const area = this.totalInterior * ratio;
    const aspect = 0.35 + this.rng() * 2.45;                       // 0.35 ~ 2.8 (길쭉한 형태 허용)
    let w = Math.round(Math.sqrt(area * aspect));
    let h = Math.round(area / Math.max(1, w));
    w = Math.max(8, Math.min(w, iw));
    h = Math.max(8, Math.min(h, ih));
    // 직사각형 전체가 내부에 들어오도록 좌상단 위치를 랜덤 배치
    const x0 = B + Math.floor(this.rng() * (iw - w + 1));
    const y0 = B + Math.floor(this.rng() * (ih - h + 1));
    this.revealX = x0 + (w >> 1); this.revealY = y0 + (h >> 1);
    let gained = 0;
    for (let y = y0; y < y0 + h; y++)
      for (let x = x0; x < x0 + w; x++) {
        const i = idx(x, y);
        if (this.grid[i] === EMPTY) { this.setGrid(i, CLAIMED); gained++; }
      }
    this.claimedInterior += gained;   // 밝힌 만큼 진행도에 반영(어느 플레이어에도 귀속되지 않음)
  }

  // 내부의 랜덤한 EMPTY 셀 중심 좌표(float). 몬스터 배치를 밝은 구역/보더 밖에 두기 위함.
  private randomEmptySpot(): [number, number] {
    for (let t = 0; t < 60; t++) {   // 기존과 같은 중앙 편향 분포로 우선 시도
      const x = COLS / 2 + (this.rng() - 0.5) * (COLS - 2 * B) * 0.7;
      const y = ROWS / 2 + (this.rng() - 0.5) * (ROWS - 2 * B) * 0.7;
      const gx = Math.floor(x), gy = Math.floor(y);
      if (inBounds(gx, gy) && this.grid[idx(gx, gy)] === EMPTY) return [x, y];
    }
    for (let t = 0; t < 300; t++) {  // 폴백: 아무 EMPTY 셀
      const gx = B + Math.floor(this.rng() * (COLS - 2 * B));
      const gy = B + Math.floor(this.rng() * (ROWS - 2 * B));
      if (this.grid[idx(gx, gy)] === EMPTY) return [gx + 0.5, gy + 0.5];
    }
    return [COLS / 2, ROWS / 2];
  }

  // 현재 안전지대(claimed)의 프론티어 셀들 — 빈칸과 맞닿은 가장자리. (재)생성 후보.
  private collectFrontier(): number[] {
    const out: number[] = [];
    for (let y = 0; y < ROWS; y++)
      for (let x = 0; x < COLS; x++)
        if (this.grid[idx(x, y)] === CLAIMED && this.isBorder(x, y)) out.push(idx(x, y));
    return out;
  }

  // (nearX,nearY) 근처의 랜덤한 안전지대 가장자리 셀을 고른다. 무작위 후보 몇 개 중
  // 가장 가까운 것을 택해 "밝아진 곳 주변의 랜덤한 안전지대"를 만족시킨다.
  private pickSafeSpawn(nearX: number, nearY: number): [number, number] {
    const F = this.collectFrontier();
    if (!F.length) return [this.revealX, this.revealY];
    let best = F[0], bestD = Infinity;
    const tries = Math.min(24, F.length);
    for (let t = 0; t < tries; t++) {
      const i = F[(this.rng() * F.length) | 0];
      const cx = i % COLS, cy = (i / COLS) | 0;
      const d = (cx - nearX) * (cx - nearX) + (cy - nearY) * (cy - nearY);
      if (d < bestD) { bestD = d; best = i; }
    }
    return [best % COLS, (best / COLS) | 0];
  }

  private pickEnemyType(): EnemyType {
    const avail = ENEMY_TYPES.filter(t => t.minLevel <= this.level);
    let total = 0; for (const t of avail) total += t.weight;
    let r = this.rng() * total;
    for (const t of avail) { r -= t.weight; if (r <= 0) return t; }
    return avail[avail.length - 1];
  }

  private makeEnemy(x: number, y: number): SimEnemy {
    const t = this.pickEnemyType();
    const ang = this.rng() * Math.PI * 2;
    const sp = this.enemySpeed * t.speed;
    // slower monsters are bigger (visual only; collisions use the center cell). Base bumped
    // 1.1 -> 2.2 so monsters stay clearly visible on the larger, zoomed-out map.
    const r = 2.2 / Math.pow(t.speed, 0.7);
    return {
      x, y,
      vx: Math.cos(ang) * sp || sp,
      vy: Math.sin(ang) * sp || sp,
      kind: t.key, shape: t.shape, behavior: t.behavior, speed: sp, r,
      spin: this.rng() * 6, wanderT: 0.4 + this.rng() * 1.0,
      gun: !!t.gun, fireEvery: t.fireEvery || 0, aim: ang,
      cooldown: (t.fireEvery || 2) * (0.5 + this.rng() * 0.8),
    };
  }

  // spawn one enemy at a random empty (and trail-free) cell
  spawnEnemy(): boolean {
    for (let t = 0; t < 300; t++) {
      const x = B + Math.floor(this.rng() * (COLS - 2 * B));
      const y = B + Math.floor(this.rng() * (ROWS - 2 * B));
      const i = idx(x, y);
      if (this.grid[i] === EMPTY && this.trail[i] === 0) {
        this.enemies.push(this.makeEnemy(x + 0.5, y + 0.5));
        return true;
      }
    }
    return false;
  }

  // ── 보스 ─────────────────────────────────────────────────────────────────
  private shuffledBosses(): BossType[] {
    const a = BOSS_TYPES.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(this.rng() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  // 지정 종류의 보스를 내부의 빈 곳에 생성하고 출현 이벤트를 기록한다.
  // 실제 보스 생성 — 지정 위치(예고 블랙홀 자리)에서 튀어나온다.
  private spawnBoss(t: BossType, x: number, y: number) {
    const ang = this.rng() * TAU2;
    const sp = this.enemySpeed * t.speed;
    this.enemies.push({
      x, y,
      vx: Math.cos(ang) * sp || sp, vy: Math.sin(ang) * sp || sp,
      kind: t.key, shape: t.shape, behavior: t.behavior, speed: sp, r: t.r,
      spin: this.rng() * 6, wanderT: 0.5 + this.rng(),
      gun: false, fireEvery: t.fireEvery, cooldown: t.fireEvery * 0.5, aim: ang,
      boss: true, pattern: t.pattern, bullets: t.bullets, phase: 0,
      mode: "normal", modeT: 4 + this.rng() * 3, baseSpeed: sp, fireEveryBase: t.fireEvery, behaviorSaved: t.behavior, baseR: t.r, rTarget: t.r,
    });
  }

  // 블랙홀이 뜰 위치: 맵 내부의 "아직 차지하지 않은 빈(EMPTY) 셀" 중 랜덤. 이미 채워진(claimed)
  // 공간에는 생성하지 않는다 — 안 그러면 보스가 플레이어가 못 들어가는 채운 영역에 갇힌다.
  private pickWarpSpot(): [number, number] {
    const lo = B + BOSS_WARP_ERASE_R;
    const spanX = Math.max(1, COLS - 2 * lo), spanY = Math.max(1, ROWS - 2 * lo);
    for (let t = 0; t < 200; t++) {   // 원이 안에 들어오는 범위에서 빈 셀을 랜덤 탐색
      const x = lo + Math.floor(this.rng() * spanX);
      const y = lo + Math.floor(this.rng() * spanY);
      if (this.grid[idx(x, y)] === EMPTY) return [x + 0.5, y + 0.5];
    }
    // 폴백: 내부 전체에서 아무 빈 셀 (거의 다 채워진 후반부 대비)
    for (let y = B; y < ROWS - B; y++)
      for (let x = B; x < COLS - B; x++)
        if (this.grid[idx(x, y)] === EMPTY) return [x + 0.5, y + 0.5];
    return [COLS / 2, ROWS / 2];
  }

  // 현재 살아있는 보스 수.
  private bossAlive(): number {
    let n = 0; for (const e of this.enemies) if (e.boss) n++; return n;
  }

  // 블랙홀 예고를 건다: 위치에 pendingWarp 를 만들고 즉시 예고 이벤트를 보낸다(클라 경고).
  // 단, 동시에 최대 3마리 한도 — (현재 보스 + 예고 대기)가 3 이상이면 이번 예고는 건너뛴다.
  private scheduleWarp(t: BossType) {
    if (this.bossAlive() + this.pendingWarps.length >= BOSS_MAX_ALIVE) return;
    const [x, y] = this.pickWarpSpot();
    this.pendingWarps.push({ x, y, type: t, t: BOSS_WARP_SEC });
    this.warpEvents.push({ x, y, kind: t.key });
  }

  // 블랙홀이 터질 때: 원형 범위의 내부 claimed 셀을 EMPTY 로 되돌리고(맵 원상복구),
  // 범위 안 플레이어를 죽인다. 외곽 벽 링은 지우지 않는다.
  private blackholeErase(x: number, y: number, R: number) {
    const cx = Math.floor(x), cy = Math.floor(y), R2 = (R + 0.5) * (R + 0.5);
    let erased = 0;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy > R2) continue;
        const gx = cx + dx, gy = cy + dy;
        if (gx < B || gy < B || gx >= COLS - B || gy >= ROWS - B) continue;
        const i = idx(gx, gy);
        if (this.grid[i] === CLAIMED) { this.setGrid(i, EMPTY); this.claimedInterior--; erased++; }
      }
    }
    if (this.claimedInterior < 0) this.claimedInterior = 0;
    this.reduceClaimCredit(erased);   // 플레이어별 점유(%)도 지운 만큼 재계산
    for (const p of this.players) {
      if (p.out) continue;
      const ddx = p.x - x, ddy = p.y - y;
      if (ddx * ddx + ddy * ddy <= R2) this.killPlayer(p);   // 블랙홀 자리에 있으면 사망
    }
  }

  // 맵이 지워진 만큼(erased) 플레이어별 점유 카운트도 비례 차감해 진행/개인 퍼센트를 일관되게 유지.
  // 지운 셀 중 시작 안전지대(무귀속)분을 제외한 "플레이어 귀속 추정분"만 각자 비율대로 뺀다.
  private reduceClaimCredit(erased: number) {
    if (erased <= 0) return;
    let sum = 0; for (const p of this.players) sum += p.claimed;
    if (sum <= 0) return;
    const before = this.claimedInterior + erased;                 // 지우기 전 총 점유(근사 분모)
    const playerPortion = erased * (sum / Math.max(sum, before));  // 그중 플레이어 귀속 추정분
    for (const p of this.players) {
      if (p.claimed > 0) p.claimed = Math.max(0, p.claimed - Math.round(playerPortion * (p.claimed / sum)));
    }
  }

  // 예고가 끝난 블랙홀 처리: 매 틱 타이머를 줄이고, 끝나면 맵 지우기 + 보스 등장.
  private updatePendingWarps(dtSec: number) {
    for (let i = this.pendingWarps.length - 1; i >= 0; i--) {
      const w = this.pendingWarps[i];
      w.t -= dtSec;
      if (w.t <= 0) {
        this.blackholeErase(w.x, w.y, BOSS_WARP_ERASE_R);
        this.spawnBoss(w.type, w.x, w.y);
        this.pendingWarps.splice(i, 1);
      }
    }
  }

  // 인원수에 따른 한 웨이브의 보스 수: 4명이면 2마리, 그 외 1마리.
  private bossCount(): number {
    return this.players.length >= 4 ? 2 : 1;
  }

  // 한 번의 출현으로 블랙홀 예고를 여러 개 건다(인원수만큼). 첫 종류는 지정, 추가분은 랜덤.
  private spawnBossWave(t: BossType) {
    const n = this.bossCount();
    this.scheduleWarp(t);
    for (let k = 1; k < n; k++) {
      this.scheduleWarp(BOSS_TYPES[Math.floor(this.rng() * BOSS_TYPES.length)]);
    }
  }

  // dev 소환 예약: 버튼을 누르면 4종을 순환하며 다음 보스를 대기열 맨 앞에 넣고 10초 뒤 등장
  // 시킨다 (카운트다운 + 블랙홀 연출을 그대로 확인). 실제 생성은 update 의 타이머가 처리.
  scheduleBossDev() {
    const t = BOSS_TYPES[this.devBossIdx % BOSS_TYPES.length];
    this.devBossIdx++;
    this.bossQueue.unshift(t);
    this.bossTimer = 10;
    this.bossIn = 10;
  }

  // 보스 행동 모드 갱신: 평상시 ↔ 격노를 주기적으로 오간다. 격노는 3종 중 랜덤:
  //  · chase  — 플레이어 추격(hunt) + 이동 속도 급증
  //  · rush   — 현재 방향으로 매우 빠르게 질주(벽에 튕김)
  //  · burst  — 발사 간격을 대폭 줄여 탄막 난사
  // 이동 로직이 vx,vy 크기를 속도로 쓰므로 모드 전환 시 벡터를 새 속도로 재정규화한다.
  private updateBossMode(e: SimEnemy, dtSec: number) {
    // 크기를 목표값(rTarget)으로 매 틱 부드럽게 접근 → 돌진 시 서서히 커졌다 서서히 작아짐.
    if (e.rTarget != null && e.r !== e.rTarget) {
      e.r += (e.rTarget - e.r) * Math.min(1, dtSec * 7);
      if (Math.abs(e.r - e.rTarget) < 0.02) e.r = e.rTarget;
    }
    e.modeT = (e.modeT ?? 0) - dtSec;
    if (e.modeT > 0) return;
    const base = e.baseSpeed || e.speed;
    if (!e.mode || e.mode === "normal") {
      // devour: 나를 향해 달려들며 점유지를 파먹는 파괴 모드
      const modes = ["chase", "rush", "burst", "devour"];
      e.mode = modes[Math.floor(this.rng() * modes.length)];
      e.modeT = 3 + this.rng() * 2;   // 격노 지속 3~5초
      // 달려드는 모드(chase/devour)는 조금 더 빠르게. 대신 돌진 중엔 발사를 멈춘다(아래 발사부).
      // 돌진 계열(chase/rush/devour)은 덩치를 키운다(1.5배, rTarget 으로 부드럽게). burst 는 그대로.
      const bigR = (e.baseR || e.r) * 1.5;
      if (e.mode === "chase") { e.behaviorSaved = e.behavior; e.behavior = "hunt"; e.speed = base * 2.2; e.rTarget = bigR; }
      else if (e.mode === "rush") { e.speed = base * 2.8; e.rTarget = bigR; }
      else if (e.mode === "burst") { e.fireEvery = (e.fireEveryBase || e.fireEvery) * 0.4; }
      else if (e.mode === "devour") { e.behaviorSaved = e.behavior; e.behavior = "hunt"; e.speed = base * 2.0; e.rTarget = bigR; e.modeT = 4 + this.rng() * 2; }
    } else {
      if (e.behaviorSaved) e.behavior = e.behaviorSaved;   // chase/devour 로 바꿨던 행동 복구
      e.mode = "normal";
      e.modeT = 5 + this.rng() * 3;   // 평상시 5~8초
      e.speed = base;
      e.fireEvery = e.fireEveryBase || e.fireEvery;
      e.rTarget = e.baseR || e.r;     // 크기 목표 원복 (부드럽게 축소)
    }
    const cur = Math.hypot(e.vx, e.vy) || 1;   // 방향 유지, 크기만 새 속도로
    e.vx = e.vx / cur * e.speed; e.vy = e.vy / cur * e.speed;
  }

  // devour 파먹기: 보스 주변 반경의 내부(interior) claimed 셀을 EMPTY 로 되돌리고(진행도 감소),
  // 그 범위 안에 있는 플레이어는 "맵이 사라지며" 함께 죽는다. 외곽 벽 링은 파먹지 않는다.
  private devour(e: SimEnemy) {
    const R = Math.max(2, Math.round((e.r || 4) * 0.7));
    const cx = Math.floor(e.x), cy = Math.floor(e.y);
    const R2 = (R + 0.5) * (R + 0.5);
    let erased = 0;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        if (dx * dx + dy * dy > R2) continue;
        const x = cx + dx, y = cy + dy;
        if (x < B || y < B || x >= COLS - B || y >= ROWS - B) continue;   // 외곽 벽 제외
        const i = idx(x, y);
        if (this.grid[i] === CLAIMED) { this.setGrid(i, EMPTY); this.claimedInterior--; erased++; }
      }
    }
    if (this.claimedInterior < 0) this.claimedInterior = 0;
    this.reduceClaimCredit(erased);   // 플레이어별 점유(%)도 파먹은 만큼 재계산
    for (const p of this.players) {
      if (p.out) continue;
      const ddx = p.x - e.x, ddy = p.y - e.y;
      if (ddx * ddx + ddy * ddy <= R2) this.killPlayer(p);   // 파먹힌 자리에 있으면 사망
    }
  }

  private fireBullet(e: SimEnemy, ang: number, speed: number) {
    if (this.projectiles.length >= MAX_PROJECTILES) return;
    this.projectiles.push({
      x: e.x, y: e.y,
      vx: Math.cos(ang) * speed, vy: Math.sin(ang) * speed,
      life: BULLET_LIFE, r: 0.9,
    });
  }

  // 보스 발사 패턴: 종류마다 다른 다방향 난사.
  private fireBossVolley(e: SimEnemy, tgt: SimPlayer | null) {
    const n = e.bullets || 8;
    const sp = BOSS_BULLET_SPEED;
    if (e.pattern === "radial") {
      // 사방으로 고르게 (정지형 방사포)
      for (let k = 0; k < n; k++) this.fireBullet(e, (k / n) * TAU2, sp);
    } else if (e.pattern === "spiral") {
      // 매 발사마다 각도를 조금씩 돌려 나선을 그린다
      e.phase = (e.phase || 0) + 0.5;
      for (let k = 0; k < n; k++) this.fireBullet(e, e.phase + (k / n) * TAU2, sp);
    } else if (e.pattern === "cross") {
      // 축 정렬 ↔ 대각선 교대로 발사 → 십자 확산 펄스 (안/바깥 두 겹)
      e.phase = (e.phase || 0) + 1;
      const off = (e.phase % 2) ? Math.PI / 4 : 0;
      for (let k = 0; k < 4; k++) {
        const a = off + k * (Math.PI / 2);
        this.fireBullet(e, a, sp);
        this.fireBullet(e, a, sp * 0.6);
      }
    } else { // spread: 가장 가까운 플레이어를 향한 부채꼴
      if (!tgt) return;
      const spread = 0.9;
      for (let k = 0; k < n; k++) {
        const a = (e.aim || 0) + (n > 1 ? (k / (n - 1) - 0.5) * spread : 0);
        this.fireBullet(e, a, sp * 1.25);
      }
    }
  }

  private nearestTarget(e: SimEnemy): SimPlayer | null {
    let best: SimPlayer | null = null, bestD = Infinity, draw: SimPlayer | null = null, drawD = Infinity;
    for (const p of this.players) {
      if (p.out) continue;
      const d = (p.x - e.x) * (p.x - e.x) + (p.y - e.y) * (p.y - e.y);
      if (p.drawing && d < drawD) { drawD = d; draw = p; }
      if (d < bestD) { bestD = d; best = p; }
    }
    return draw || best;
  }

  addPlayer(sessionId: string, owner: number): SimPlayer {
    const [sx, sy] = this.pickSafeSpawn(this.revealX, this.revealY);   // 밝은 구역 위에서 합류
    const p: SimPlayer = {
      sessionId, owner, x: sx, y: sy, spawnX: sx, spawnY: sy,
      heldDir: null, boost: false, boosting: false, drawing: false, retreating: false, lives: START_LIVES,
      claimed: 0, traps: 0, bonus: 0, out: false, acc: 0, idle: 0,
      drawOriginX: sx, drawOriginY: sy, trailCells: [],
    };
    this.players.push(p);
    return p;
  }

  removePlayer(sessionId: string) {
    const p = this.players.find(q => q.sessionId === sessionId);
    if (p) for (const i of p.trailCells) this.setTrail(i, 0);
    this.players = this.players.filter(q => q.sessionId !== sessionId);
  }

  setInput(sessionId: string, dir: [number, number] | null) {
    const p = this.players.find(q => q.sessionId === sessionId);
    if (!p) return;
    const nd = (dir && (dir[0] || dir[1])) ? dir : null;
    const changed = (!p.heldDir) !== (!nd) ||
      (!!nd && !!p.heldDir && (nd[0] !== p.heldDir[0] || nd[1] !== p.heldDir[1]));
    p.heldDir = nd;
    // Prime the step timer on a fresh direction so the first move fires on the NEXT tick
    // (~16ms) instead of waiting up to MOVE_MS (45ms) for the accumulator. This cuts
    // turn/start latency with zero client-side prediction — the server stays authoritative.
    if (nd && changed && !p.retreating && p.acc < MOVE_MS) p.acc = MOVE_MS;
  }

  setBoost(sessionId: string, on: boolean) {
    const p = this.players.find(q => q.sessionId === sessionId);
    if (p) p.boost = on;
  }

  private isWall(x: number, y: number) { return !inBounds(x, y) || this.grid[idx(x, y)] === CLAIMED; }

  // a claimed cell is on the frontier if any 8-neighbour is empty. Players may
  // only walk the frontier of the filled picture, never through its interior.
  private isBorder(x: number, y: number): boolean {
    if (!inBounds(x, y) || this.grid[idx(x, y)] !== CLAIMED) return false;
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const ax = x + dx, ay = y + dy;
        if (inBounds(ax, ay) && this.grid[idx(ax, ay)] === EMPTY) return true;
      }
    return false;
  }

  private step(p: SimPlayer, dx: number, dy: number) {
    if (this.over || p.out || (dx === 0 && dy === 0)) return;
    const nx = p.x + dx, ny = p.y + dy;
    if (!inBounds(nx, ny)) return;
    const ni = idx(nx, ny);
    if (this.trail[ni] !== 0) return;               // blocked by any trail
    if (this.grid[ni] === CLAIMED) {
      // on the filled area, only travel the frontier (never cut through interior)
      if (!p.drawing && this.isBorder(p.x, p.y) && !this.isBorder(nx, ny)) return;
      p.x = nx; p.y = ny;
      if (p.drawing) { this.closeArea(p); p.drawing = false; }
    } else {
      if (!p.drawing) { p.drawOriginX = p.x; p.drawOriginY = p.y; p.idle = 0; }
      p.drawing = true; p.x = nx; p.y = ny;
      this.setTrail(ni, p.owner); p.trailCells.push(ni);
    }
  }

  // stalled mid-draw: retrace the unfinished line back to its start, cell by cell
  private startRetreat(p: SimPlayer) {
    if (!p.drawing || !p.trailCells.length) { p.drawing = false; return; }
    p.drawing = false; p.retreating = true; p.idle = 0; p.acc = 0;
  }
  private retreatStep(p: SimPlayer) {
    if (!p.trailCells.length) { p.retreating = false; p.x = p.drawOriginX; p.y = p.drawOriginY; return; }
    const tip = p.trailCells.pop()!;
    this.setTrail(tip, 0);
    if (p.trailCells.length) {
      const back = p.trailCells[p.trailCells.length - 1];
      p.x = back % COLS; p.y = (back / COLS) | 0;
    } else {
      p.x = p.drawOriginX; p.y = p.drawOriginY; p.retreating = false;
    }
  }

  private closeArea(p: SimPlayer) {
    let gained = 0;
    for (const i of p.trailCells) {
      if (this.grid[i] === EMPTY) { this.setGrid(i, CLAIMED); gained++; }
      this.setTrail(i, 0);
    }
    p.trailCells.length = 0;

    // label connected components of the remaining EMPTY cells
    const comp = new Int32Array(N).fill(-1);
    const size: number[] = []; const enemiesOf: SimEnemy[][] = [];
    let nComp = 0; const stack: number[] = [];
    for (let s = 0; s < N; s++) {
      if (this.grid[s] !== EMPTY || comp[s] !== -1) continue;
      const id = nComp++;
      comp[s] = id; stack.length = 0; stack.push(s);
      let count = 0;
      while (stack.length) {
        const cur = stack.pop()!; count++;
        const cx = cur % COLS, cy = (cur / COLS) | 0;
        const nb: [number, number][] = [[cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1]];
        for (const [ax, ay] of nb) {
          if (!inBounds(ax, ay)) continue;
          const ai = idx(ax, ay);
          if (this.grid[ai] === EMPTY && comp[ai] === -1) { comp[ai] = id; stack.push(ai); }
        }
      }
      size[id] = count; enemiesOf[id] = [];
    }
    for (const e of this.enemies) {
      const ex = Math.floor(e.x), ey = Math.floor(e.y);
      if (inBounds(ex, ey)) { const c = comp[idx(ex, ey)]; if (c >= 0) enemiesOf[c].push(e); }
    }

    // only the largest enemy region stays open; smaller ones are claimed + captured
    let mainId = -1, mainSize = -1;
    for (let id = 0; id < nComp; id++)
      if (enemiesOf[id].length && size[id] > mainSize) { mainSize = size[id]; mainId = id; }
    const trapThreshold = this.totalInterior * TRAP_RATIO;
    const claimIt = new Uint8Array(nComp);
    const trapped = new Set<SimEnemy>();
    let trapCount = 0, trapSX = 0, trapSY = 0;
    for (let id = 0; id < nComp; id++) {
      const es = enemiesOf[id];
      if (es.length === 0) { claimIt[id] = 1; continue; }
      const keepOpen = (id === mainId) && size[id] > trapThreshold;
      if (!keepOpen) {
        claimIt[id] = 1;
        for (const e of es) { trapped.add(e); trapSX += e.x; trapSY += e.y; trapCount++; }
      }
    }
    for (let i = 0; i < N; i++)
      if (this.grid[i] === EMPTY && comp[i] >= 0 && claimIt[comp[i]]) { this.setGrid(i, CLAIMED); gained++; }

    if (trapCount > 0) {
      // 등급별 점수: 잡힌 각 적의 아키타입 점수를 합산
      let bonus = 0;
      for (const e of trapped) bonus += CAPTURE_SCORE[e.kind] ?? CAPTURE_SCORE_DEFAULT;
      this.enemies = this.enemies.filter(e => !trapped.has(e));
      p.traps += trapCount;
      p.bonus += bonus;
      this.captureEvents.push({
        x: trapSX / trapCount, y: trapSY / trapCount,
        count: trapCount, bonus, owner: p.owner,
      });
    }

    p.claimed += gained;
    this.claimedInterior += gained;
    while (this.spawnThresholds.length && this.ratio >= this.spawnThresholds[0]) {
      this.spawnThresholds.shift();
      this.spawnEnemy();
    }
    if (this.ratio >= CLEAR_RATIO) this.over = "won";
  }

  private killPlayer(p: SimPlayer) {
    for (const i of p.trailCells) this.setTrail(i, 0);
    p.trailCells.length = 0;
    p.drawing = false; p.retreating = false;
    // 죽으면 밝아진 구역 주변의 랜덤한 안전지대로 재생성 (고정 스폰 대신)
    const [sx, sy] = this.pickSafeSpawn(this.revealX, this.revealY);
    p.x = sx; p.y = sy; p.spawnX = sx; p.spawnY = sy;
    p.drawOriginX = sx; p.drawOriginY = sy; p.acc = 0; p.idle = 0;
    p.lives--;
    if (p.lives <= 0) {
      p.out = true;
      if (this.players.length && this.players.every(q => q.out)) this.over = "lost";
    }
  }

  update(dtSec: number) {
    if (this.over) return;

    // 보스 스케줄: 라운드 경과 시간이 임계치를 넘으면 대기열의 다음 보스를 등장시킨다.
    this.roundElapsed += dtSec;
    this.bossTimer -= dtSec;
    if (this.bossTimer <= 0) {
      if (this.bossQueue.length === 0) this.bossQueue = this.shuffledBosses();   // 4종 소진 시 재섞어 무한 순환
      this.spawnBossWave(this.bossQueue.shift()!);   // 블랙홀 예고를 건다 (4명이면 2개)
      this.bossTimer = BOSS_INTERVAL_SEC;            // 이후 2분마다 반복
    }
    this.updatePendingWarps(dtSec);   // 예고가 끝난 블랙홀 → 맵 지우기 + 보스 등장
    // 다음 보스까지 남은 시간 — 보스는 계속 등장하므로 항상 카운트다운(클라가 ≤10s면 WARNING).
    this.bossIn = Math.max(0, this.bossTimer);

    // players: retrace if stalled mid-draw, otherwise advance on the step timer
    for (const p of this.players) {
      if (p.out) continue;
      if (p.retreating) {
        // retrace faster than normal movement so the marker snaps back quickly
        p.acc += dtSec * 1000;
        let guard = 0;
        while (p.acc >= RETRACE_MS && guard++ < 12) { p.acc -= RETRACE_MS; this.retreatStep(p); if (!p.retreating) break; }
        continue;
      }
      const held = p.heldDir;
      if (p.drawing) {
        if (held) p.idle = 0;
        else { p.idle += dtSec * 1000; if (p.idle >= STALL_MS) { this.startRetreat(p); continue; } }
      } else p.idle = 0;

      // Sprint (Shift) moves BOOST_MULT x faster, paid per boosted cell from capture bonus.
      p.boosting = !!(p.boost && held && p.bonus >= BOOST_COST);
      p.acc += dtSec * 1000;
      let guard = 0;
      while (guard++ < 8) {
        const canBoost = !!(p.boost && held && p.bonus >= BOOST_COST);
        const interval = canBoost ? MOVE_MS / BOOST_MULT : MOVE_MS;
        if (p.acc < interval) break;
        p.acc -= interval;
        if (held) {
          if (canBoost) { p.bonus -= BOOST_COST; p.boosting = true; }
          this.step(p, held[0], held[1]);
        }
      }
    }

    // enemies: per-archetype steering, bounce, kill on trail contact, shoot
    for (const e of this.enemies) {
      e.spin += dtSec * 8;
      if (e.boss) this.updateBossMode(e, dtSec);   // 주기적 격노(추격/질주/난사) 전환
      // turrets are stationary emplacements — they never move, only aim and fire (below)
      if (e.behavior !== "turret") {
        if (e.behavior === "wander") {
          e.wanderT -= dtSec;
          if (e.wanderT <= 0) {
            e.wanderT = 0.6 + this.rng() * 1.2;
            const a = Math.atan2(e.vy, e.vx) + (this.rng() - 0.5) * 1.7;
            const sp = Math.hypot(e.vx, e.vy) || e.speed;
            e.vx = Math.cos(a) * sp; e.vy = Math.sin(a) * sp;
          }
        } else if (e.behavior === "hunt") {
          const tgt = this.nearestTarget(e);
          if (tgt) {
            const dx = tgt.x - e.x, dy = tgt.y - e.y;
            const d = Math.hypot(dx, dy) || 1;
            const sp = Math.hypot(e.vx, e.vy) || e.speed;
            e.vx += (dx / d) * sp * dtSec * 1.8;
            e.vy += (dy / d) * sp * dtSec * 1.8;
            const cur = Math.hypot(e.vx, e.vy) || 1;
            e.vx = e.vx / cur * sp; e.vy = e.vy / cur * sp;
          }
        }

        const nx = e.x + e.vx * dtSec;
        if (this.isWall(Math.floor(nx), Math.floor(e.y))) e.vx = -e.vx; else e.x = nx;
        const ny = e.y + e.vy * dtSec;
        if (this.isWall(Math.floor(e.x), Math.floor(ny))) e.vy = -e.vy; else e.y = ny;
      }

      if (e.boss && e.mode === "devour") this.devour(e);   // 점유지 파먹기 + 범위 내 플레이어 사망

      const owner = this.trail[idx(Math.floor(e.x), Math.floor(e.y))];
      if (owner) {
        const p = this.players.find(q => q.owner === owner);
        if (p) this.killPlayer(p);
      }

      if (e.boss) {
        // 보스: 종류별 다방향 난사. 조준(spread)과 회전 연출을 위해 항상 aim 갱신.
        const tgt = this.nearestTarget(e);
        if (tgt) e.aim = Math.atan2(tgt.y - e.y, tgt.x - e.x);
        e.cooldown -= dtSec;
        if (e.cooldown <= 0) {
          e.cooldown = e.fireEvery!;
          // 나를 향해 달려드는 동안(chase/devour)은 투사체를 쏘지 않는다 (돌진+난사는 너무 빡셈).
          const charging = e.mode === "chase" || e.mode === "devour";
          if (!charging) this.fireBossVolley(e, tgt);
        }
      } else if (e.gun) {
        const tgt = this.nearestTarget(e);
        if (tgt) e.aim = Math.atan2(tgt.y - e.y, tgt.x - e.x);
        e.cooldown -= dtSec;
        if (e.cooldown <= 0 && tgt) {
          e.cooldown = e.fireEvery * (0.85 + this.rng() * 0.3);
          this.projectiles.push({
            x: e.x, y: e.y,
            vx: Math.cos(e.aim) * BULLET_SPEED, vy: Math.sin(e.aim) * BULLET_SPEED,
            life: BULLET_LIFE, r: 0.9,
          });
        }
      }
    }

    // projectiles fly over walls and the safe zone; kill on direct or trail hit.
    // 예외: 안전지대(claimed 셀) 위에 서 있는 플레이어는 포탑 미사일에 맞지 않는다. 선을
    // 긋는 중(open 셀 위)이거나 되돌아가는 중이면 노출된 상태이므로 그대로 죽는다.
    for (let k = this.projectiles.length - 1; k >= 0; k--) {
      const pr = this.projectiles[k];
      pr.x += pr.vx * dtSec; pr.y += pr.vy * dtSec; pr.life -= dtSec;
      let gone = pr.life <= 0 || pr.x < 0 || pr.y < 0 || pr.x >= COLS || pr.y >= ROWS;
      if (!gone) {
        for (const p of this.players) {
          if (p.out) continue;
          if (this.grid[idx(p.x, p.y)] === CLAIMED) continue;   // 안전지대에 있으면 미사일 무효
          const dx = p.x - pr.x, dy = p.y - pr.y;
          if (dx * dx + dy * dy < 1.6 * 1.6) { this.killPlayer(p); gone = true; break; }
        }
      }
      if (!gone) {
        const bx = Math.floor(pr.x), by = Math.floor(pr.y);
        if (inBounds(bx, by)) {
          const owner = this.trail[idx(bx, by)];
          if (owner) { const p = this.players.find(q => q.owner === owner); if (p) { this.killPlayer(p); gone = true; } }
        }
      }
      if (gone) this.projectiles.splice(k, 1);
    }
  }
}
