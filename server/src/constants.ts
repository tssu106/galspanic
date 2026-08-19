// Grid dimensions. 64x64 = 4096 cells — the smooth, playable size (smaller grid =
// fewer cells to sync and draw). Camera is off (fixed full-map view).
export const GRID_W = 64;
export const GRID_H = 64;

// Claimed border ring thickness.
export const BORDER = 2;

// Clear the round when this fraction of the *interior* is claimed.
export const CLEAR_RATIO = 0.85;

// Simulation cadence (server-authoritative). Sim and broadcast are DECOUPLED so they can
// be tuned independently. Kept at ~60Hz: raising to 120/90Hz overloaded the HOST (which
// runs the server AND its browser on one machine) and made input feel stuck/very slow.
export const SIM_MS = 16;     // ~60 Hz physics
export const PATCH_MS = 16;   // ~60 Hz state broadcast
export const MOVE_MS = 32;    // one cell per 32ms = exactly 2 sim ticks (2 x SIM_MS).
                              // Aligning to the tick makes the step cadence regular, so the
                              // client glide is constant-velocity (no micro-stutter). 26ms
                              // wasn't a tick multiple, so cells moved every 16/32ms → uneven.

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
