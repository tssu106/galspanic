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
export const SIM_MS = 24;     // ~42 Hz physics (unchanged: keeps collision/carve accuracy)
export const PATCH_MS = 33;   // ~30 Hz state broadcast. Decoupled from the sim: physics still
                              // runs at 42Hz, we just serialize+send deltas less often. On tiny
                              // instances (e.g. Render Free 0.1 core) the big cells/trail/web
                              // array change-tracking dominates CPU, so fewer broadcasts = big
                              // CPU/bandwidth savings and fewer carve-time spikes. Client
                              // interpolation keeps 30Hz visually smooth.
export const MOVE_MS = 24;    // one cell per 24ms = ~42 cells/s (2x the old 48ms cadence, test).
                              // With SIM_MS=24 that's one cell per sim tick; client interpolation
                              // over PATCH_MS still smooths motion. Physics rate stays flat (no
                              // extra host load). Rule of thumb for a 2-tick glide is SIM_MS =
                              // MOVE_MS / 2, but we keep SIM_MS at 24 to avoid doubling sim load.

// Shift-to-sprint: hold Shift to move BOOST_MULT x faster while STAMINA lasts. Stamina is a
// separate 0..100 gauge (NOT the capture score): it drains slowly while sprinting and refills
// slowly otherwise. Capture points (bonus) are kept purely as score now.
export const BOOST_MULT = 1.5;
export const STAMINA_MAX = 100;
export const STAMINA_DRAIN = 120;   // 질주 중 초당 소모 (100 → 약 0.83초 지속)
export const STAMINA_RECOVER = 20;  // 비질주 시 초당 회복 (0 → 100 약 5초, 회복 느림)

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

// 빠른 참가(공개) 방은 첫 입장부터 이 시간(초) 뒤 자동 시작한다. 혼자여도 로비에서 멈추지 않고
// 곧바로 게임으로 넘어가되, 그 짧은 사이 다른 빠른참가 유저가 합류하면 같은 방에서 함께 시작한다
// (즉시 시작의 마찰 제거 + 협동 매칭 양립). 비공개(방 만들기) 방은 대상이 아니다.
export const QUICK_START_SECS = 3;

// ── 점수 & 이어하기 ─────────────────────────────────────────────
// 스테이지 클리어 점수 = 깊이 + 커버리지 + 포획 + (기존)포획보너스 + 속도 보너스.
// 런 점수는 스테이지를 넘어갈수록 이들의 누적(이어하기 시 일부 차감).
export const SCORE_LEVEL = 100;       // 스테이지(깊이) 1당 기본 점수
export const SCORE_COVER = 500;       // 점유율(0..1) 환산 계수
export const SCORE_TRAP = 30;         // 몬스터 1마리 포획당
export const SCORE_SPEED_BASE = 2000; // 속도 보너스 상한(빨리 깰수록 큼)
export const SCORE_SPEED_DROP = 20;   // 초당 감소 (100초부터 속도 보너스 0)
// 이어하기(전멸 후 현재 스테이지 재도전): 목숨·점수 일부만 유지.
export const CONTINUE_LIVES = 2;        // 이어하기 시 목숨(정상 3에서 감소)
export const CONTINUE_SCORE_KEEP = 0.8; // 이어하기 시 런 점수 20% 차감
export const MAX_CONTINUES = 2;         // 한 런에서 이어하기 가능 횟수. 초과하면 처음 스테이지부터 다시.

// ── 로그라이트 버프(boons) ──────────────────────────────────────
// 스테이지 클리어마다 이 중 3개를 무작위로 제시하고, 하나를 골라 런 내내 누적 적용한다.
// 효과 크기는 여기서 관리(서버 권위). 이름/설명 문구는 클라 i18n(boon_*).
export const BOON_IDS = ["life", "score", "slow", "speed", "stam"] as const;
export const BOON_OFFER_COUNT = 3;      // 매 클리어에 제시하는 후보 수
export const BOON_SCORE_ADD = 0.3;      // "점수" 1스택당 런 점수 배수 +0.3
export const BOON_SLOW_MULT = 0.85;     // "둔화" 1스택당 적 속도 ×0.85
export const BOON_SPEED_MULT = 0.88;    // "신속" 1스택당 이동 간격 ×0.88 (=더 빠름)
export const BOON_STAM_MULT = 1.4;      // "지구력" 1스택당 스태미나 지속·회복 ×1.4

// ── 코옵 부활 ──: 쓰러진 동료 위치에 살아있는 동료가 다가가 잠시 있으면 되살린다(솔로는 동료가 없어 무효).
export const REVIVE_RADIUS = 4;   // 부활 인정 거리(셀)
export const REVIVE_SEC = 2.5;    // 부활에 필요한 시간(초)
export const REVIVE_LIVES = 1;    // 부활 시 목숨

// Background artwork pool (219 images). GameRoom.imageAt shuffles this each cycle and
// assigns one per stage, so every stage in a cycle gets a distinct, non-overlapping image
// (and no repeat across the seam), reshuffling only after all 219 have been shown.
// Ids art01..art09, art10..art99, art100..art219 — one file each at
// server/public/images/<id>_blur.jpg, matching the client's artId zero-padding.
export const IMAGE_POOL: string[] =
  Array.from({ length: 219 }, (_, i) => "art" + String(i + 1).padStart(2, "0"));

// Direction code (sent by clients) -> delta.
export const DIRS: Record<number, [number, number]> = {
  0: [0, 0],   // none
  1: [0, -1],  // up
  2: [0, 1],   // down
  3: [-1, 0],  // left
  4: [1, 0],   // right
};
