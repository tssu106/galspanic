import { Room, Client } from "@colyseus/core";
import { GameState, Player, Enemy, Projectile } from "./schema";
import { GalSim } from "./GalSim";
import type { SimEnemy } from "./GalSim";
import { SIM_MS, PATCH_MS, MOVE_MS, MAX_PLAYERS, IMAGE_POOL, DIRS, WIN_COUNTDOWN_MS } from "./constants";

const COLORS = ["#22d3ee", "#f472b6", "#a3e635", "#fb923c"];

export class GameRoom extends Room<GameState> {
  maxClients = MAX_PLAYERS;
  sim!: GalSim;
  private wonElapsed = 0;   // ms accumulated on the between-stage win countdown

  onCreate() {
    this.setState(new GameState());
    // Broadcast state patches at PATCH_MS (~90Hz) instead of the 50ms/20Hz default.
    // Decoupled from the faster sim so bandwidth stays bounded while input stays fresh.
    this.setPatchRate(PATCH_MS);
    this.sim = new GalSim(1);
    this.initGridSchema();
    this.startRound(1);
    // tell clients the authoritative step cadence so their prediction matches exactly
    this.state.moveMs = MOVE_MS;

    // Client sends a held direction code (0..4). Server is authoritative.
    this.onMessage("input", (client, msg: { dir: number }) => {
      const d = DIRS[msg?.dir as number] || DIRS[0];
      this.sim.setInput(client.sessionId, [d[0], d[1]]);
    });

    this.onMessage("restart", () => {
      // A win auto-advances via the between-stage countdown (no instant skip);
      // only a loss restarts (from level 1) when a player hits Enter.
      if (this.state.phase === "lost") this.startRound(1);
    });

    // Authoritative simulation loop (fast, decoupled from the broadcast rate).
    this.setSimulationInterval((dt) => this.tick(dt), SIM_MS);
  }

  private initGridSchema() {
    this.state.cells = new (this.state.cells.constructor as any)();
    this.state.trail = new (this.state.trail.constructor as any)();
    for (let i = 0; i < this.sim.cellCount; i++) {
      this.state.cells.push(this.sim.grid[i]);
      this.state.trail.push(this.sim.trail[i]);
    }
    this.state.totalInterior = this.sim.totalInterior;
  }

  startRound(level: number) {
    this.sim.resetRound(level);
    // push full grid once (dirty sets already hold every changed cell, but be explicit)
    for (let i = 0; i < this.sim.cellCount; i++) {
      this.state.cells[i] = this.sim.grid[i];
      this.state.trail[i] = this.sim.trail[i];
    }
    this.sim.gridDirty.clear();
    this.sim.trailDirty.clear();

    // rebuild enemy + projectile schema lists
    this.state.enemies.splice(0, this.state.enemies.length);
    for (const e of this.sim.enemies) this.state.enemies.push(this.makeEnemySchema(e));
    this.state.projectiles.splice(0, this.state.projectiles.length);

    this.state.level = level;
    this.state.claimedInterior = 0;
    this.state.imageId = IMAGE_POOL[(level - 1) % IMAGE_POOL.length];
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
    this.sim.gridDirty.clear();
    this.sim.trailDirty.clear();

    // sync players
    this.sim.players.forEach((sp) => {
      const p = this.state.players.get(sp.sessionId);
      if (!p) return;
      p.x = sp.x; p.y = sp.y;
      p.drawing = sp.drawing ? 1 : 0;
      p.retreating = sp.retreating ? 1 : 0;
      p.lives = sp.lives; p.claimed = sp.claimed; p.out = sp.out ? 1 : 0;
      p.traps = sp.traps; p.bonus = sp.bonus;
    });

    // enemies can grow (reveal spawns) or shrink (captures) — match the list length
    while (this.state.enemies.length < this.sim.enemies.length)
      this.state.enemies.push(this.makeEnemySchema(this.sim.enemies[this.state.enemies.length]));
    while (this.state.enemies.length > this.sim.enemies.length)
      this.state.enemies.pop();
    for (let i = 0; i < this.sim.enemies.length; i++) {
      const se = this.sim.enemies[i]!, es = this.state.enemies[i]!;
      es.x = se.x; es.y = se.y; es.aim = se.aim;
      if (es.kind !== se.kind) { es.kind = se.kind; es.shape = se.shape; es.r = se.r; }
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

    // broadcast capture events for client popups/sound, then clear
    if (this.sim.captureEvents.length) {
      for (const ev of this.sim.captureEvents) this.broadcast("trap", ev);
      this.sim.captureEvents.length = 0;
    }

    this.state.claimedInterior = this.sim.claimedInterior;
    if (this.sim.over) {
      this.state.phase = this.sim.over;   // "won" | "lost"
      if (this.sim.over === "won") {
        this.wonElapsed = 0;
        this.state.nextIn = WIN_COUNTDOWN_MS / 1000;
        // publish the next stage's image now so clients can preload it during the countdown
        this.state.nextImageId = IMAGE_POOL[this.sim.level % IMAGE_POOL.length];
      }
    }
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
