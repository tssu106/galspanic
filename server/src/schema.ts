import { Schema, MapSchema, ArraySchema, type } from "@colyseus/schema";
import { GRID_W, GRID_H } from "./constants";

// A player's marker. The server owns the truth; clients only send input.
export class Player extends Schema {
  @type("string") id: string = "";
  @type("string") name: string = "";
  @type("string") color: string = "#ffffff";
  @type("number") owner: number = 0;    // 1-based slot; matches trail cell values
  @type("number") x: number = 0;        // grid coords
  @type("number") y: number = 0;
  @type("number") drawing: number = 0;  // 0/1 — currently laying a trail
  @type("number") lives: number = 3;
  @type("number") claimed: number = 0;  // interior cells this player has claimed
  @type("number") out: number = 0;      // 0/1 — eliminated this round
}

// An enemy marker (position only; velocity stays server-side).
export class Enemy extends Schema {
  @type("number") x: number = 0;
  @type("number") y: number = 0;
}

export class GameState extends Schema {
  @type("number") gridW: number = GRID_W;
  @type("number") gridH: number = GRID_H;

  // Flat cell arrays. cells: 0 = empty, 1 = claimed. trail: 0 = none, else owner slot.
  @type(["number"]) cells = new ArraySchema<number>();
  @type(["number"]) trail = new ArraySchema<number>();

  @type("number") claimedInterior: number = 0;
  @type("number") totalInterior: number = 0;
  @type("number") level: number = 1;

  // "lobby" | "playing" | "won" | "lost"
  @type("string") phase: string = "lobby";

  // Public id of the current image (client fetches a BLURRED version only).
  @type("string") imageId: string = "";

  @type({ map: Player }) players = new MapSchema<Player>();
  @type([Enemy]) enemies = new ArraySchema<Enemy>();
}
