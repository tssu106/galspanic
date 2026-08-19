import { GRID_W, GRID_H, BORDER as B, CLEAR_RATIO, MOVE_MS, START_LIVES } from "./constants";

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
const TRAP_BONUS = 400;    // capture bonus points per trapped monster
const BULLET_SPEED = 20;   // cells/sec for gunner projectiles
const BULLET_LIFE = 4;     // seconds

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
}

export interface SimProjectile { x: number; y: number; vx: number; vy: number; life: number; r: number; }
export interface CaptureEvent { x: number; y: number; count: number; bonus: number; owner: number; }

const SPAWNS: [number, number][] = [
  [B, B - 1], [COLS - 1 - B, B - 1], [B, ROWS - B], [COLS - 1 - B, ROWS - B],
];

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
  level = 1;
  totalInterior = (COLS - 2 * B) * (ROWS - 2 * B);
  claimedInterior = 0;
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
    for (let i = 0; i < N; i++) { this.setGrid(i, EMPTY); this.setTrail(i, 0); }
    for (let y = 0; y < ROWS; y++)
      for (let x = 0; x < COLS; x++)
        if (x < B || y < B || x >= COLS - B || y >= ROWS - B) this.setGrid(idx(x, y), CLAIMED);

    for (const p of this.players) {
      const [sx, sy] = SPAWNS[(p.owner - 1) % 4];
      p.x = sx; p.y = sy; p.spawnX = sx; p.spawnY = sy;
      p.drawing = false; p.retreating = false; p.out = false; p.lives = START_LIVES;
      p.claimed = 0; p.traps = 0; p.bonus = 0; p.acc = 0; p.idle = 0;
      p.drawOriginX = sx; p.drawOriginY = sy; p.trailCells.length = 0;
    }

    this.enemies = [];
    this.enemySpeed = 9 + (level - 1) * 1.8;   // cells per second (gentle base, gradual per-level ramp)
    this.spawnThresholds = [0.20, 0.40, 0.60];
    const active = Math.max(1, this.players.length);
    const count = 2 + active + (level - 1) * 2;   // more monsters: bigger base + faster per-level growth
    for (let i = 0; i < count; i++) {
      this.enemies.push(this.makeEnemy(
        COLS / 2 + (this.rng() - 0.5) * 16,
        ROWS / 2 + (this.rng() - 0.5) * 12,
      ));
    }
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
    // slower monsters are bigger (visual only; collisions use the center cell)
    const r = 1.1 / Math.pow(t.speed, 0.7);
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
    const [sx, sy] = SPAWNS[(owner - 1) % 4];
    const p: SimPlayer = {
      sessionId, owner, x: sx, y: sy, spawnX: sx, spawnY: sy,
      heldDir: null, drawing: false, retreating: false, lives: START_LIVES,
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
      this.enemies = this.enemies.filter(e => !trapped.has(e));
      p.traps += trapCount;
      p.bonus += TRAP_BONUS * trapCount;
      this.captureEvents.push({
        x: trapSX / trapCount, y: trapSY / trapCount,
        count: trapCount, bonus: TRAP_BONUS * trapCount, owner: p.owner,
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
    p.x = p.spawnX; p.y = p.spawnY; p.acc = 0; p.idle = 0;
    p.lives--;
    if (p.lives <= 0) {
      p.out = true;
      if (this.players.length && this.players.every(q => q.out)) this.over = "lost";
    }
  }

  update(dtSec: number) {
    if (this.over) return;

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

      p.acc += dtSec * 1000;
      let guard = 0;
      while (p.acc >= MOVE_MS && guard++ < 4) {
        p.acc -= MOVE_MS;
        if (held) this.step(p, held[0], held[1]);
      }
    }

    // enemies: per-archetype steering, bounce, kill on trail contact, shoot
    for (const e of this.enemies) {
      e.spin += dtSec * 8;
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

      const owner = this.trail[idx(Math.floor(e.x), Math.floor(e.y))];
      if (owner) {
        const p = this.players.find(q => q.owner === owner);
        if (p) this.killPlayer(p);
      }

      if (e.gun) {
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

    // projectiles fly over walls and the safe zone; kill on direct or trail hit
    for (let k = this.projectiles.length - 1; k >= 0; k--) {
      const pr = this.projectiles[k];
      pr.x += pr.vx * dtSec; pr.y += pr.vy * dtSec; pr.life -= dtSec;
      let gone = pr.life <= 0 || pr.x < 0 || pr.y < 0 || pr.x >= COLS || pr.y >= ROWS;
      if (!gone) {
        for (const p of this.players) {
          if (p.out) continue;
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
