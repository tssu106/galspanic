import { GRID_W, GRID_H, BORDER as B, CLEAR_RATIO, MOVE_MS, START_LIVES } from "./constants";

const COLS = GRID_W, ROWS = GRID_H, N = COLS * ROWS;
const EMPTY = 0, CLAIMED = 1;
const idx = (x: number, y: number) => y * COLS + x;
const inBounds = (x: number, y: number) => x >= 0 && y >= 0 && x < COLS && y < ROWS;

export interface SimPlayer {
  sessionId: string;
  owner: number;             // 1-based slot, equals trail cell value
  x: number; y: number;
  spawnX: number; spawnY: number;
  heldDir: [number, number] | null;
  drawing: boolean;
  lives: number;
  claimed: number;
  out: boolean;
  acc: number;               // ms accumulator for the move timer
  trailCells: number[];
}

export interface SimEnemy { x: number; y: number; vx: number; vy: number; }

const SPAWNS: [number, number][] = [
  [B, B - 1], [COLS - 1 - B, B - 1], [B, ROWS - B], [COLS - 1 - B, ROWS - B],
];

/**
 * Authoritative Qix-style simulation. DOM-free; a faithful port of the local
 * engine (client/local.html). The room copies its state into the Colyseus
 * schema each tick.
 */
export class GalSim {
  grid = new Uint8Array(N);
  trail = new Uint8Array(N);
  players: SimPlayer[] = [];
  enemies: SimEnemy[] = [];
  level = 1;
  totalInterior = (COLS - 2 * B) * (ROWS - 2 * B);
  claimedInterior = 0;
  over: null | "won" | "lost" = null;
  enemySpeed = 8;
  spawnThresholds: number[] = [];   // reveal marks that add an enemy

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
    this.over = null;
    this.claimedInterior = 0;
    for (let i = 0; i < N; i++) { this.setGrid(i, EMPTY); this.setTrail(i, 0); }
    for (let y = 0; y < ROWS; y++)
      for (let x = 0; x < COLS; x++)
        if (x < B || y < B || x >= COLS - B || y >= ROWS - B) this.setGrid(idx(x, y), CLAIMED);

    // reset players to their spawn
    for (const p of this.players) {
      const [sx, sy] = SPAWNS[(p.owner - 1) % 4];
      p.x = sx; p.y = sy; p.spawnX = sx; p.spawnY = sy;
      p.drawing = false; p.out = false; p.lives = START_LIVES;
      p.claimed = 0; p.acc = 0; p.trailCells.length = 0;
    }

    // enemies scale with players & level, and grow as the picture is revealed
    this.enemies = [];
    this.enemySpeed = 8 + (level - 1) * 1.5;   // cells per second
    this.spawnThresholds = [0.20, 0.40, 0.60];
    const active = Math.max(1, this.players.length);
    const count = 1 + active + (level - 1);
    for (let i = 0; i < count; i++) {
      const ang = Math.random() * Math.PI * 2;
      this.enemies.push({
        x: COLS / 2 + (Math.random() - 0.5) * 16,
        y: ROWS / 2 + (Math.random() - 0.5) * 12,
        vx: Math.cos(ang) * this.enemySpeed || this.enemySpeed,
        vy: Math.sin(ang) * this.enemySpeed || this.enemySpeed,
      });
    }
  }

  // spawn one enemy at a random empty (and trail-free) cell
  spawnEnemy(): boolean {
    for (let t = 0; t < 300; t++) {
      const x = B + Math.floor(Math.random() * (COLS - 2 * B));
      const y = B + Math.floor(Math.random() * (ROWS - 2 * B));
      const i = idx(x, y);
      if (this.grid[i] === EMPTY && this.trail[i] === 0) {
        const ang = Math.random() * Math.PI * 2;
        this.enemies.push({
          x: x + 0.5, y: y + 0.5,
          vx: Math.cos(ang) * this.enemySpeed || this.enemySpeed,
          vy: Math.sin(ang) * this.enemySpeed || this.enemySpeed,
        });
        return true;
      }
    }
    return false;
  }

  addPlayer(sessionId: string, owner: number): SimPlayer {
    const [sx, sy] = SPAWNS[(owner - 1) % 4];
    const p: SimPlayer = {
      sessionId, owner, x: sx, y: sy, spawnX: sx, spawnY: sy,
      heldDir: null, drawing: false, lives: START_LIVES, claimed: 0,
      out: false, acc: 0, trailCells: [],
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
    if (p) p.heldDir = (dir && (dir[0] || dir[1])) ? dir : null;
  }

  private isWall(x: number, y: number) { return !inBounds(x, y) || this.grid[idx(x, y)] === CLAIMED; }

  private step(p: SimPlayer, dx: number, dy: number) {
    if (this.over || p.out || (dx === 0 && dy === 0)) return;
    const nx = p.x + dx, ny = p.y + dy;
    if (!inBounds(nx, ny)) return;
    const ni = idx(nx, ny);
    if (this.trail[ni] !== 0) return;               // blocked by any trail
    if (this.grid[ni] === CLAIMED) {
      p.x = nx; p.y = ny;
      if (p.drawing) { this.closeArea(p); p.drawing = false; }
    } else {
      p.drawing = true; p.x = nx; p.y = ny;
      this.setTrail(ni, p.owner); p.trailCells.push(ni);
    }
  }

  private closeArea(p: SimPlayer) {
    let gained = 0;
    for (const i of p.trailCells) {
      if (this.grid[i] === EMPTY) { this.setGrid(i, CLAIMED); gained++; }
      this.setTrail(i, 0);
    }
    p.trailCells.length = 0;

    const reach = new Uint8Array(N);
    const stack: number[] = [];
    for (const e of this.enemies) {
      const ex = Math.floor(e.x), ey = Math.floor(e.y);
      if (inBounds(ex, ey) && this.grid[idx(ex, ey)] === EMPTY && !reach[idx(ex, ey)]) {
        reach[idx(ex, ey)] = 1; stack.push(ex, ey);
      }
    }
    while (stack.length) {
      const y = stack.pop()!, x = stack.pop()!;
      const nb: [number, number][] = [[x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]];
      for (const [ax, ay] of nb) {
        if (!inBounds(ax, ay)) continue;
        const ai = idx(ax, ay);
        if (this.grid[ai] === EMPTY && !reach[ai]) { reach[ai] = 1; stack.push(ax, ay); }
      }
    }
    for (let i = 0; i < N; i++)
      if (this.grid[i] === EMPTY && !reach[i]) { this.setGrid(i, CLAIMED); gained++; }

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
    p.drawing = false;
    p.x = p.spawnX; p.y = p.spawnY; p.acc = 0;
    p.lives--;
    if (p.lives <= 0) {
      p.out = true;
      if (this.players.length && this.players.every(q => q.out)) this.over = "lost";
    }
  }

  update(dtSec: number) {
    if (this.over) return;
    // players advance on a fixed step timer
    for (const p of this.players) {
      if (p.out) continue;
      p.acc += dtSec * 1000;
      let guard = 0;
      while (p.acc >= MOVE_MS && guard++ < 4) {
        p.acc -= MOVE_MS;
        if (p.heldDir) this.step(p, p.heldDir[0], p.heldDir[1]);
      }
    }
    // enemies bounce and kill on contact with a trail
    for (const e of this.enemies) {
      const nx = e.x + e.vx * dtSec;
      if (this.isWall(Math.floor(nx), Math.floor(e.y))) e.vx = -e.vx; else e.x = nx;
      const ny = e.y + e.vy * dtSec;
      if (this.isWall(Math.floor(e.x), Math.floor(ny))) e.vy = -e.vy; else e.y = ny;
      const owner = this.trail[idx(Math.floor(e.x), Math.floor(e.y))];
      if (owner) {
        const p = this.players.find(q => q.owner === owner);
        if (p) this.killPlayer(p);
      }
    }
  }
}
