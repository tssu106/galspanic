// Determinism check: run the sim with a FIXED seed and no player input for a fixed
// number of ticks, then print a hash of the enemy positions. Running this twice must
// give the same hash (proves the seeded sim is reproducible); comparing against the
// browser bundle's hash proves cross-engine (Node V8 vs browser) determinism.
import { createHash } from "crypto";
import { GalSim } from "../src/GalSim";

const SEED = 123456789;
const TICKS = 600;      // 600 * 20ms = 12s of sim
const DT = 0.02;

const s = new GalSim(1);
s.gameSeed = SEED;
s.resetRound(1);        // re-seeds rng from gameSeed
for (let i = 0; i < TICKS; i++) s.update(DT);

let blob = `enemies=${s.enemies.length};`;
for (const e of s.enemies) blob += `${e.x.toFixed(6)},${e.y.toFixed(6)},${e.vx.toFixed(6)},${e.vy.toFixed(6)};`;
const hash = createHash("md5").update(blob).digest("hex");

console.log(JSON.stringify({ seed: SEED, ticks: TICKS, enemies: s.enemies.length, hash, sample: blob.slice(0, 120) }));
