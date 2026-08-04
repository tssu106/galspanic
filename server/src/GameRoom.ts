import { Room, Client } from "@colyseus/core";
import { GameState, Player, Enemy } from "./schema";
import { GalSim } from "./GalSim";
import { TICK_MS, MAX_PLAYERS, IMAGE_POOL, DIRS } from "./constants";

const COLORS = ["#22d3ee", "#f472b6", "#a3e635", "#fb923c"];

export class GameRoom extends Room<GameState> {
  maxClients = MAX_PLAYERS;
  sim!: GalSim;

  onCreate() {
    this.setState(new GameState());
    this.sim = new GalSim(1);
    this.initGridSchema();
    this.startRound(1);

    // Client sends a held direction code (0..4). Server is authoritative.
    this.onMessage("input", (client, msg: { dir: number }) => {
      const d = DIRS[msg?.dir as number] || DIRS[0];
      this.sim.setInput(client.sessionId, [d[0], d[1]]);
    });

    this.onMessage("restart", () => {
      if (this.state.phase === "won" || this.state.phase === "lost") {
        const nextLevel = this.state.phase === "won" ? this.sim.level + 1 : 1;
        this.startRound(nextLevel);
      }
    });

    // Authoritative simulation loop.
    this.setSimulationInterval((dt) => this.tick(dt), TICK_MS);
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

    // rebuild enemy schema list
    this.state.enemies.splice(0, this.state.enemies.length);
    for (const e of this.sim.enemies) {
      const es = new Enemy(); es.x = e.x; es.y = e.y;
      this.state.enemies.push(es);
    }

    this.state.level = level;
    this.state.claimedInterior = 0;
    this.state.imageId = IMAGE_POOL[(level - 1) % IMAGE_POOL.length];
    this.state.phase = "playing";

    // reflect reset player stats
    this.sim.players.forEach((sp) => {
      const p = this.state.players.get(sp.sessionId);
      if (p) { p.x = sp.x; p.y = sp.y; p.lives = sp.lives; p.claimed = 0; p.out = 0; p.drawing = 0; }
    });
  }

  tick(dt: number) {
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
      p.lives = sp.lives; p.claimed = sp.claimed; p.out = sp.out ? 1 : 0;
    });

    // the sim may add enemies mid-round as the reveal grows — mirror them
    while (this.state.enemies.length < this.sim.enemies.length) {
      const se = this.sim.enemies[this.state.enemies.length];
      const es = new Enemy(); es.x = se.x; es.y = se.y;
      this.state.enemies.push(es);
    }
    // sync enemies (positions only)
    for (let i = 0; i < this.sim.enemies.length && i < this.state.enemies.length; i++) {
      const es = this.state.enemies[i];
      if (es) { es.x = this.sim.enemies[i].x; es.y = this.sim.enemies[i].y; }
    }

    this.state.claimedInterior = this.sim.claimedInterior;
    if (this.sim.over) this.state.phase = this.sim.over;   // "won" | "lost"
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
