// Grid dimensions. 64x64 = 4096 cells — the smooth, playable size (smaller grid =
// fewer cells to sync and draw). Camera is off (fixed full-map view).
export const GRID_W = 64;
export const GRID_H = 64;

// Claimed border ring thickness.
export const BORDER = 2;

// Clear the round when this fraction of the *interior* is claimed.
export const CLEAR_RATIO = 0.85;

// Simulation cadence (server-authoritative). 50Hz keeps host load LOW (server + its browser
// share one machine; higher rates felt stuck) while client interpolation keeps motion smooth.
export const SIM_MS = 24;     // ~42 Hz physics
export const PATCH_MS = 24;   // ~42 Hz state broadcast (matches the sim)
export const MOVE_MS = 48;    // one cell per 48ms = exactly 2 sim ticks (SIM_MS x 2) → regular
                              // cadence, smooth constant-velocity glide. ~21 cells/s (a bit slower).
                              // Rule of thumb: keep SIM_MS = MOVE_MS / 2 so a cell is always 2 ticks.

// After clearing a stage, auto-advance to the next one over this countdown (client shows a bar).
export const WIN_COUNTDOWN_MS = 5000;

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
