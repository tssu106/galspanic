// Grid dimensions. Incrementally widening the playable field from the old 64x64.
// 256x256 = 65536 cells (~16x vs 64). A self-centered zoom camera (client index.html, VIEW=44)
// keeps the on-screen stroke feel constant regardless of grid size. Earlier, bigger grids
// felt janky, but that was a CLIENT bug (indexing the Colyseus ArraySchema per cell every
// frame — ~11µs/cell), not an inherent grid cost. The client now copies the schema arrays
// to plain arrays once per frame (~500x cheaper), so per-frame cost stays flat as the grid
// grows and we can keep widening the field in later steps.
// Field is PORTRAIT 2:3 to match the reveal artwork (512x768). A square grid squished the
// portrait picture; with a 2:3 grid the client canvas (512x768) uses exactly-square 3.2px
// cells, so the image shows undistorted both in play and on the clear screen.
export const GRID_W = 160;
export const GRID_H = 240;

// Claimed border ring thickness.
export const BORDER = 2;

// Clear the round when this fraction of the *interior* is claimed.
export const CLEAR_RATIO = 0.90;

// Simulation cadence (server-authoritative). ~42Hz keeps host load LOW (server + its browser
// share one machine; higher rates felt stuck) while client interpolation keeps motion smooth.
export const SIM_MS = 24;     // ~42 Hz physics
export const PATCH_MS = 24;   // ~42 Hz state broadcast (matches the sim)
export const MOVE_MS = 24;    // one cell per 24ms = ~42 cells/s (2x the old 48ms cadence, test).
                              // With SIM_MS=24 that's one cell per sim tick; client interpolation
                              // over PATCH_MS still smooths motion. Physics rate stays flat (no
                              // extra host load). Rule of thumb for a 2-tick glide is SIM_MS =
                              // MOVE_MS / 2, but we keep SIM_MS at 24 to avoid doubling sim load.

// Shift-to-sprint: hold Shift to move BOOST_MULT x faster, paid for out of capture
// bonus points (BOOST_COST per boosted cell). No banked bonus -> no sprint.
export const BOOST_MULT = 1.5;
export const BOOST_COST = 6;

// 라운드 시작 시 내부(interior)의 랜덤한 위치를 미리 밝힌다(안전지대). 이 값은 밝히는
// 직사각형 넓이의 기준치로, 실제 넓이·가로세로 비율은 이 값 주변에서 매 판 랜덤하게 정해진다
// (revealStartArea 참고). 플레이어는 이 밝아진 구역의 경계에서 시작하고, 죽으면 밝아진 구역
// 주변의 안전지대 경계에 다시 생성된다. (기존의 고정 4코너 스폰을 대체)
export const START_REVEAL_RATIO = 0.05;

// After clearing a stage, auto-advance to the next one over this countdown (client shows a bar).
export const WIN_COUNTDOWN_MS = 5000;

// Up to 4 concurrent markers (four corner spawns), matching the local build.
export const MAX_PLAYERS = 4;
export const START_LIVES = 3;

// Background artwork pool. The server picks one per stage via IMAGE_POOL[(level-1) % N]
// (see GameRoom.startRound), so stages 1..N each get a distinct, non-overlapping image
// and the sequence wraps only after the pool is exhausted.
export const IMAGE_POOL = [
  "art01", "art02", "art03", "art04", "art05", "art06", "art07", "art08", "art09", "art10",
  "art11", "art12", "art13", "art14", "art15", "art16", "art17", "art18", "art19", "art20",
  "art21", "art22", "art23", "art24", "art25", "art26", "art27", "art28", "art29", "art30",
  "art31", "art32", "art33", "art34", "art35", "art36", "art37",
];

// Direction code (sent by clients) -> delta.
export const DIRS: Record<number, [number, number]> = {
  0: [0, 0],   // none
  1: [0, -1],  // up
  2: [0, 1],   // down
  3: [-1, 0],  // left
  4: [1, 0],   // right
};
