// Grid dimensions. 256x256 = 65536 cells. Camera is off (fixed full-map view), so
// the whole field shows at once with very small cells (~2.8px on a 720 canvas).
// Initial full sync is large (~130KB) but deltas during play stay small.
export const GRID_W = 256;
export const GRID_H = 256;

// Claimed border ring thickness.
export const BORDER = 2;

// Clear the round when this fraction of the *interior* is claimed.
export const CLEAR_RATIO = 0.8;

// Simulation cadence (server-authoritative).
export const TICK_MS = 16;    // ~60 Hz physics/broadcast (was 33/30Hz)
export const MOVE_MS = 45;    // player advances one cell every 45ms while holding a direction

// Up to 4 concurrent markers (four corner spawns), matching the local build.
export const MAX_PLAYERS = 4;
export const START_LIVES = 3;

// How many images are in the pool (server picks one per round, keeps it secret).
export const IMAGE_POOL = [
  "art01",
  "art02",
  "art03",
];

// Direction code (sent by clients) -> delta.
export const DIRS: Record<number, [number, number]> = {
  0: [0, 0],   // none
  1: [0, -1],  // up
  2: [0, 1],   // down
  3: [-1, 0],  // left
  4: [1, 0],   // right
};
