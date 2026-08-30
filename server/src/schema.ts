import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";
import { GRID_W, GRID_H, MOVE_MS } from "./constants";

// A player's marker. The server owns the truth; clients only send input.
export class Player extends Schema {
  @type("string") id: string = "";
  @type("string") name: string = "";
  @type("string") color: string = "#ffffff";
  @type("number") owner: number = 0;    // 1-based slot; matches trail cell values
  @type("number") x: number = 0;        // grid coords
  @type("number") y: number = 0;
  @type("number") drawing: number = 0;  // 0/1 — currently laying a trail
  @type("number") retreating: number = 0; // 0/1 — retracing a stalled line
  @type("number") boosting: number = 0;  // 0/1 — sprinting (Shift), spending capture bonus
  @type("number") lives: number = 3;
  @type("number") claimed: number = 0;  // interior cells this player has claimed
  @type("number") traps: number = 0;    // monsters captured
  @type("number") bonus: number = 0;    // capture score (accumulates; no longer spent on sprint)
  @type("number") stamina: number = 100; // 0..100 sprint gauge (drains while boosting, recovers otherwise)
  @type("number") out: number = 0;      // 0/1 — eliminated this round
  @type("number") inv: number = 0;      // 0/1 — invincible (spawn/respawn grace) → client draws marker faint
}

// An enemy marker. Position + aim sync; archetype look (kind/shape/size) too.
export class Enemy extends Schema {
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("string") kind: string = "star";  // archetype key -> client color/shape
  @type("string") shape: string = "star";
  @type("number") r: number = 1;           // radius in cells (size = slower is bigger)
  @type("number") aim: number = 0;         // facing angle (gunner barrel / dart nose)
  @type("number") enr: number = 0;         // 0/1 — boss enraged (chase/rush/burst) → client red aura
  @type("number") sh: number = 0;          // 1 — shielder invincible now (client draws a shield ring)
  @type("number") st: number = 0;          // 1 — phantom hidden now (client draws it faint)
}

// A gunner's bullet (position only; it ignores walls and kills even on safe zone).
export class Projectile extends Schema {
  @type("number") x: number = 0;
  @type("number") y: number = 0;
}

// A boss laser beam (cell coords). on=0 → telegraph/warning line; on=1 → firing.
export class Beam extends Schema {
  @type("number") x1: number = 0;
  @type("number") y1: number = 0;
  @type("number") x2: number = 0;
  @type("number") y2: number = 0;
  @type("number") w: number = 1;    // half-width in cells
  @type("number") on: number = 0;   // 0 telegraph, 1 firing
}

// 맵 위 아이템 (점유하며 획득). kind: shield|missile|freeze|life
export class Item extends Schema {
  @type("number") x: number = 0;
  @type("number") y: number = 0;
  @type("string") kind: string = "shield";
  @type("number") blink: number = 0;   // 1 = 소멸 직전(클라가 깜빡임)
}
// 미사일 아이템으로 발사된 유도 미사일 (렌더용 위치만)
export class Missile extends Schema {
  @type("number") x: number = 0;
  @type("number") y: number = 0;
}

export class GameState extends Schema {
  @type("number") gridW: number = GRID_W;
  @type("number") gridH: number = GRID_H;

  // Flat cell arrays. cells: 0 = empty, 1 = claimed. trail: 0 = none, else owner slot.
  @type(["number"]) cells = new ArraySchema<number>();
  @type(["number"]) trail = new ArraySchema<number>();
  // web: 0 = none, 1 = spider web (a boss hazard that slows players standing on it).
  @type(["number"]) web = new ArraySchema<number>();

  @type("number") claimedInterior: number = 0;
  @type("number") totalInterior: number = 0;
  @type("number") level: number = 1;

  // Authoritative move cadence (ms/cell) — clients mirror it for local prediction.
  @type("number") moveMs: number = MOVE_MS;

  // Seconds left on the between-stage countdown (only meaningful while phase === "won").
  @type("number") nextIn: number = 0;

  // Seconds until the next boss spawns (-1 = no more bosses this round). Clients show a
  // translucent WARNING countdown once this drops to ≤10s.
  @type("number") bossIn: number = -1;

  // Lobby start countdown: seconds until the game begins (-1 = still waiting).
  @type("number") startIn: number = -1;

  // "lobby" | "playing" | "won" | "lost"
  @type("string") phase: string = "lobby";

  // Public id of the current image (client fetches a BLURRED version only).
  @type("string") imageId: string = "";

  // Id of the NEXT stage's image, published when a stage is won so the client can
  // preload it during the countdown → the next stage starts with no loading hitch.
  @type("string") nextImageId: string = "";

  // Deterministic RNG game seed. Clients can run the same seeded sim (mulberry32,
  // re-seeded per round from seed ^ level) for client-side prediction / lockstep.
  @type("number") seed: number = 0;

  // 프리즈 아이템: 적이 얼어있는 동안 1.
  @type("number") frozen: number = 0;

  @type({ map: Player }) players = new MapSchema<Player>();
  @type([Enemy]) enemies = new ArraySchema<Enemy>();
  @type([Projectile]) projectiles = new ArraySchema<Projectile>();
  @type([Beam]) beams = new ArraySchema<Beam>();
  @type([Item]) items = new ArraySchema<Item>();
  @type([Missile]) missiles = new ArraySchema<Missile>();
}
