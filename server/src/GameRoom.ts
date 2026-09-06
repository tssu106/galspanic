import { Room, Client } from "@colyseus/core";
import { GameState, Player, Enemy, Projectile, Beam, Item, Missile } from "./schema";
import { GalSim } from "./GalSim";
import type { SimEnemy } from "./GalSim";
import { SIM_MS, PATCH_MS, MOVE_MS, MAX_PLAYERS, IMAGE_POOL, DIRS, QUICK_START_SECS,
         SCORE_LEVEL, SCORE_COVER, SCORE_TRAP, SCORE_SPEED_BASE, SCORE_SPEED_DROP,
         CONTINUE_LIVES, CONTINUE_SCORE_KEEP, MAX_CONTINUES,
         BOON_IDS, BOON_OFFER_COUNT, BOON_SCORE_ADD, BOON_SLOW_MULT, BOON_SPEED_MULT, BOON_STAM_MULT,
         BOON_GUARD_ADD, BOON_QUICK_SUB, BOON_LUCK_MULT, BOON_IRON_ADD, BOON_REVEAL_MULT, BOON_HUNTER_MULT, BOON_FROST_ADD,
         BOON_RARITY, BOON_WEIGHT, freshMods, REVIVE_SEC } from "./constants";
import { verifyToken, recordUnlock, recordBest, submitDaily } from "./supa";
import { dailyKey, dailySeed } from "./daily";

const COLORS = ["#22d3ee", "#f472b6", "#a3e635", "#fb923c"];
const PICK_SECS = 5;   // 코옵 버프 선택 제한시간(초): 이 시간이 지나면 미선택자는 자동 선택된다.

// dev 서버(로컬 npm start)일 때만 클라이언트가 보낸 시작 레벨을 신뢰한다. 프로덕션에서는
// 항상 레벨 1로 시작한다 (임의 레벨 점프 차단).
const DEV = process.env.NODE_ENV !== "production";

export class GameRoom extends Room<GameState> {
  maxClients = MAX_PLAYERS;
  sim!: GalSim;
  private startLevel = 1;   // 이 방이 시작한 레벨 (loss 후 재시작도 이 레벨로 되돌린다)
  private isPrivate = false; // "방 만들기"(친구끼리)로 만든 비공개 방 → 빠른참가 자동 시작 대상 아님
  private runScore = 0;      // 이번 런 누적 점수(스테이지 합산, 이어하기 시 일부 차감)
  private roundStartMs = 0;  // 현재 스테이지 시작 시각(클리어 시간 측정용)
  private continues = 0;     // 이번 런에서 이어하기한 횟수
  private pickEndsAt = 0;     // 코옵 버프 선택 마감 시각(ms). 0 이면 타이머 없음(솔로). Date.now() 기준.
  private imageSeq: string[] = [];   // 스테이지별 배경 이미지 순서(랜덤 셔플, 한 바퀴 동안 비중복)
  private enemySeq = 0;              // 적 스폰 id 카운터(라운드 넘어가도 재사용 안 함 → 전역 유일)
  private userIds = new Map<string, string>();   // sessionId → Supabase user id (토큰 검증됨). 도감 기록용.
  private isDaily = false;    // 데일리 챌린지 방(솔로, 날짜 시드, 이어하기 없음, 랭킹 제출)
  private dailyDay = "";      // 이 데일리 방의 날짜 키(KST "YYYY-MM-DD")
  private scoreMult = 1;      // 로그라이트 "점수" 버프 누적 배수
  private bonusLives = 0;     // 로그라이트 "생명" 버프 누적(매 스테이지 기본 목숨에 가산)
  private boonStacks: Record<string, number> = {};   // 적용된 버프 id → 스택 수(클라 표시용)

  onCreate(options: { level?: number; private?: boolean; daily?: boolean } = {}) {
    this.isDaily = !!options.daily;
    // dev 에서만 방을 만든 클라이언트가 고른 스테이지로 시작. 데일리·프로덕션은 항상 레벨 1.
    this.startLevel = (DEV && !this.isDaily) ? this.clampLevel(options.level) : 1;
    // "방 만들기"·데일리 방은 비공개 → 빠른 참가(joinOrCreate) 매칭에서 제외.
    this.isPrivate = this.isDaily || !!options.private;
    if (this.isPrivate) this.setPrivate(true);
    this.setState(new GameState());
    // Broadcast state patches at PATCH_MS (~30Hz). Decoupled from the 42Hz sim so the
    // host serializes/sends deltas less often (big CPU/bandwidth win on tiny instances)
    // while physics stays accurate; client interpolation keeps motion smooth.
    this.setPatchRate(PATCH_MS);
    this.sim = new GalSim(this.startLevel);
    if (this.isDaily) {
      // 그날의 시드로 고정 → 모두 같은 보드. 클라에 데일리 모드도 알린다.
      this.dailyDay = dailyKey();
      this.sim.gameSeed = dailySeed(this.dailyDay);
      this.state.daily = 1;
      this.sim.dailyBoss = true;   // 데일리: 시작부터 체력 있는 보스 1마리 (미사일로 처치)
    }
    this.state.seed = this.sim.gameSeed;   // deterministic seed clients can replay
    this.initGridSchema();
    // 게임을 바로 시작하지 않고 로비에서 대기한다. 4명이 되면 10초 카운트다운 후 시작(아래 tick),
    // 또는 로비의 "지금 시작"으로 시작. startRound 는 시작 시점에 호출한다.
    this.state.phase = "lobby";
    this.state.startIn = -1;   // 시작 카운트다운 남은 초 (-1 = 대기 중)
    // tell clients the authoritative step cadence so their prediction matches exactly
    this.state.moveMs = MOVE_MS;

    // Client sends a held direction code (0..4). Server is authoritative.
    this.onMessage("input", (client, msg: { dir: number; boost?: boolean }) => {
      const d = DIRS[msg?.dir as number] || DIRS[0];
      this.sim.setInput(client.sessionId, [d[0], d[1]]);
      this.sim.setBoost(client.sessionId, !!msg?.boost);
    });

    // 로비 "지금 시작": 대기 중이든 자동 카운트다운 중이든, 1명 이상 있으면 곧바로(1초 뒤) 시작.
    // (기존엔 카운트다운이 이미 돌고 있으면 무시돼 빠른참가 방에서 버튼이 먹통이었다 → 항상 먹히게)
    this.onMessage("startNow", () => {
      if (this.state.phase === "lobby" && this.state.players.size >= 1) {
        this.state.startIn = this.state.startIn < 0 ? 1 : Math.min(this.state.startIn, 1);
      }
    });

    this.onMessage("restart", () => {
      // On the clear screen, Enter advances to the next stage (no auto-advance, so players
      // can admire the picture as long as they like). On a loss, Enter restarts: prod from
      // level 1, dev from the room's chosen start level so testing stays put.
      // 클리어 화면: 버프를 아직 안 골랐으면(=선택창이 떠 있으면) restart 로는 진행하지 않는다.
      if (this.state.phase === "won") this.beginStagePick();   // 클리어 → 다음 스테이지 시작(버프 선택) 화면
      // 이어하기(현재 스테이지 재도전). 데일리는 공정성을 위해 이어하기 없음(1회 시도).
      // 이어하기(현재 스테이지 재도전)는 MAX_CONTINUES 회까지. 초과하면 처음 스테이지부터 새 런.
      else if (this.state.phase === "lost" && !this.isDaily) {
        if (this.continues < MAX_CONTINUES) this.continueRun();
        else this.restartFromStart();
      }
    });

    // 로그라이트 버프 선택: 스테이지 "시작 화면"(phase="pick")에서 각자 자기 3택 중 하나를 고른다.
    // 코옵에선 사람마다 다르게 고를 수 있고(각 선택이 팀 런에 누적 적용), 5초 제한 뒤엔 미선택자 자동 선택.
    // 전원 선택 완료(또는 제한시간 종료)되면 버프가 적용된 채 다음 스테이지가 생성된다(resolveStagePick).
    this.onMessage("boon", (client, msg: { id?: string }) => {
      if (this.state.phase !== "pick") return;
      const p = this.state.players.get(client.sessionId);
      if (!p || p.boonPicked || !p.boonOffers) return;                    // 아직 안 고른 사람만
      const id = String(msg?.id ?? "");
      if (!p.boonOffers.split(",").includes(id)) return;                  // 자기 후보만 유효
      this.applyBoon(id);
      p.boonPicked = 1; p.boonOffers = "";                                // 이 플레이어 선택 완료
      if (this.everyonePicked()) this.resolveStagePick();                 // 전원 완료 시 즉시 진행
    });

    // dev 전용: 클라이언트의 "보스 소환" 버튼 → 10초 카운트다운 후 보스 등장 (4종 순환).
    this.onMessage("devBoss", () => {
      if (DEV && this.state.phase === "playing") this.sim.scheduleBossDev();
    });
    // dev 전용: "레이저 보스" 버튼 → 레이저 보스를 바로 소환해 곧 레이저 발사 (체험용).
    this.onMessage("devLaser", () => {
      if (DEV && this.state.phase === "playing") this.sim.devLaser();
    });
    // dev 전용: "몬스터 모두 제거" 버튼 → 필드의 적·탄·레이저·미사일·예고 보스를 즉시 비운다.
    this.onMessage("devClear", () => {
      if (DEV && this.state.phase === "playing") this.sim.devClearMonsters();
    });
    // dev 전용: "게임오버 미리보기" 버튼 → 즉시 lost 로 전환해 죽는 화면(3D 카운트다운)을 확인.
    this.onMessage("devLose", () => {
      if (DEV && this.state.phase === "playing") this.state.phase = "lost";
    });
    // dev 전용: "스테이지 완료" 버튼 → 즉시 won 으로 전환해 클리어 화면(그림 리빌)을 확인.
    this.onMessage("devWin", () => {
      if (DEV && this.state.phase === "playing") { this.state.phase = "won"; this.onStageCleared(); }
    });

    // Chat: relay a short message to everyone as a speech bubble over the sender.
    this.onMessage("chat", (client, msg: { text?: string }) => {
      const text = String(msg?.text ?? "").replace(/\s+/g, " ").trim().slice(0, 60);
      if (!text) return;
      const sp = this.sim.players.find((p) => p.sessionId === client.sessionId);
      if (sp) this.broadcast("chat", { owner: sp.owner, text });
    });

    // Authoritative simulation loop (fast, decoupled from the broadcast rate).
    this.setSimulationInterval((dt) => this.tick(dt), SIM_MS);
  }

  private initGridSchema() {
    this.state.cells = new (this.state.cells.constructor as any)();
    this.state.trail = new (this.state.trail.constructor as any)();
    this.state.web = new (this.state.web.constructor as any)();
    for (let i = 0; i < this.sim.cellCount; i++) {
      this.state.cells.push(this.sim.grid[i]);
      this.state.trail.push(this.sim.trail[i]);
      this.state.web.push(this.sim.web[i]);
    }
    this.state.totalInterior = this.sim.totalInterior;
  }

  startRound(level: number) {
    this.sim.resetRound(level);
    // Reset the grid arrays IN PLACE with setAt (O(1)/cell → O(N) total), NOT splice+push.
    // The arrays were created once in initGridSchema with stable keys 0..N-1; setAt(i, v)
    // updates that cell directly and is O(1). We must keep those keys stable, because push()
    // assigns a monotonically-increasing $refId as each item's key — so clearing and
    // repushing every round would shift every cell's key by N and break the per-tick
    // setAt(i, ...) sync (which addresses cells by 0-based index). (Avoid arr[i] = v here:
    // the ArraySchema index-set proxy runs Array.from($items.keys()) per assignment — O(N)
    // per set → O(N²) for the whole grid, the old ~32s round-start freeze.)
    for (let i = 0; i < this.sim.cellCount; i++) {
      this.state.cells.setAt(i, this.sim.grid[i]);
      this.state.trail.setAt(i, this.sim.trail[i]);
      this.state.web.setAt(i, this.sim.web[i]);
    }
    this.sim.gridDirty.clear();
    this.sim.trailDirty.clear();
    this.sim.webDirty.clear();

    // rebuild enemy + projectile + beam + item + missile schema lists
    this.state.enemies.splice(0, this.state.enemies.length);
    for (const e of this.sim.enemies) this.state.enemies.push(this.makeEnemySchema(e));
    this.state.projectiles.splice(0, this.state.projectiles.length);
    this.state.beams.splice(0, this.state.beams.length);
    this.state.missiles.splice(0, this.state.missiles.length);
    this.state.items.splice(0, this.state.items.length);
    for (const it of this.sim.items) { const s = new Item(); s.x = it.x; s.y = it.y; s.kind = it.kind; this.state.items.push(s); }
    this.state.frozen = 0;

    this.state.level = level;
    this.state.clearPct = Math.round(this.sim.clearTarget * 100);   // 속공 버프 반영된 목표 점유율(HUD 표시)
    this.state.claimedInterior = 0;
    this.state.imageId = this.imageAt(level);   // 랜덤·비중복 배정
    this.state.phase = "playing";
    this.state.nextIn = 0;
    this.state.pickEndsIn = -1;                  // 플레이 중엔 버프 선택 카운트다운 없음
    this.roundStartMs = Date.now();             // 클리어 시간 측정 시작
    this.state.stageScore = 0;
    this.state.clearMs = 0;
    this.state.runScore = this.runScore;        // 다음 스테이지/이어하기에서도 누적 점수 유지

    // 로그라이트 "생명" 버프: 매 스테이지 기본 목숨 위에 누적 보너스만큼 더 준다
    // (resetRound 가 START_LIVES 로 초기화하므로 매 라운드 다시 얹어야 유지된다).
    if (this.bonusLives) this.sim.players.forEach((sp) => { sp.lives += this.bonusLives; });

    // reflect reset player stats
    this.sim.players.forEach((sp) => {
      const p = this.state.players.get(sp.sessionId);
      if (p) {
        p.x = sp.x; p.y = sp.y; p.lives = sp.lives; p.claimed = 0; p.out = 0;
        p.drawing = 0; p.retreating = 0; p.traps = 0; p.bonus = 0;
      }
    });
  }

  // 로비 → 게임 시작: 라운드를 열고(플레이어 스폰·무적), 방을 잠가 진행 중 방엔 못 들어오게 한다.
  private beginGame() {
    this.state.startIn = -1;
    this.runScore = 0; this.continues = 0; this.state.continues = 0;   // 새 런 시작 → 누적 점수·이어하기 초기화
    this.scoreMult = 1; this.bonusLives = 0; this.boonStacks = {}; this.sim.mods = freshMods();  // 버프 초기화
    this.state.boons = ""; this.state.boonOffers = "";
    this.startRound(this.startLevel);   // phase 를 "playing" 으로 전환
    this.lock();                        // 이후 새 플레이어 입장 차단
  }

  // 버프 후보 N개를 등급 가중치대로(비중복) 뽑아 콤마 문자열로 반환. 흔한 건 자주, 전설은 드물게(BOON_WEIGHT).
  private rollOffer(): string {
    const pool = [...BOON_IDS] as string[];
    const picks: string[] = [];
    const n = Math.min(BOON_OFFER_COUNT, pool.length);
    while (picks.length < n && pool.length) {
      const total = pool.reduce((s, id) => s + BOON_WEIGHT[BOON_RARITY[id] ?? "common"], 0);
      let r = Math.random() * total, idx = 0;
      for (; idx < pool.length - 1; idx++) { r -= BOON_WEIGHT[BOON_RARITY[pool[idx]] ?? "common"]; if (r <= 0) break; }
      picks.push(pool[idx]);
      pool.splice(idx, 1);   // 비중복: 뽑힌 후보는 이번 3택 풀에서 제거
    }
    return picks.join(",");
  }

  // 플레이어마다 "자기만의" 3택을 뽑아 싣는다(코옵은 사람마다 다르게 고를 수 있게). 선택 상태 초기화.
  private offerBoons() {
    this.state.players.forEach((p) => { p.boonOffers = this.rollOffer(); p.boonPicked = 0; });
    this.state.boonOffers = "";   // 구(舊) 공용 필드는 사용 안 함
  }

  // 코옵(2인 이상)에서 아직 안 고른 사람에게 자동 선택시키고 다음 스테이지로. 전원 완료 시에도 호출.
  private resolveStagePick() {
    this.state.players.forEach((p) => {
      if (!p.boonPicked && p.boonOffers) { this.applyBoon(p.boonOffers.split(",")[0]); p.boonPicked = 1; p.boonOffers = ""; }
    });
    this.state.pickEndsIn = -1; this.pickEndsAt = 0;
    this.startRound(this.sim.level + 1);   // 모든 선택이 적용된 채 다음 스테이지 생성 → phase="playing"
  }

  // 아직 선택 안 한(후보가 남은) 플레이어가 없으면 true.
  private everyonePicked(): boolean {
    let pending = false;
    this.state.players.forEach((p) => { if (!p.boonPicked && p.boonOffers) pending = true; });
    return !pending;
  }

  // 고른 버프를 런에 누적 적용(서버 권위). 시뮬 배율/점수배수/목숨에 반영하고 스택 표시를 갱신.
  private applyBoon(id: string) {
    switch (id) {
      case "life":  this.bonusLives++; break;                                    // 매 스테이지 +1 목숨(누적)
      case "score": this.scoreMult += BOON_SCORE_ADD; break;                     // 이후 점수 배수↑
      case "slow":  this.sim.mods.enemy *= BOON_SLOW_MULT; break;                // 적 둔화
      case "speed": this.sim.mods.move *= BOON_SPEED_MULT; break;                // 이동 빨라짐
      case "stam":  this.sim.mods.stamina *= BOON_STAM_MULT; break;             // 스태미나 강화
      case "guard": this.sim.mods.guard += BOON_GUARD_ADD; break;               // 매 스테이지 죽음 무효 +1
      case "quick": this.sim.mods.clearRatio += BOON_QUICK_SUB; break;          // 클리어 목표 점유율↓
      case "luck":  this.sim.mods.itemRate *= BOON_LUCK_MULT; break;            // 아이템 더 자주
      case "iron":  this.sim.mods.invuln += BOON_IRON_ADD; break;               // 스폰/부활 무적↑
      case "reveal":this.sim.mods.reveal *= BOON_REVEAL_MULT; break;            // 시작 안전지대↑
      case "hunter":this.sim.mods.trap *= BOON_HUNTER_MULT; break;              // 포획 점수↑
      case "frost": this.sim.mods.frost += BOON_FROST_ADD; break;               // 시작 시 적 정지↑
      default: return;
    }
    this.boonStacks[id] = (this.boonStacks[id] || 0) + 1;
    this.state.boons = Object.entries(this.boonStacks).map(([k, v]) => `${k}:${v}`).join(",");
  }

  // 이어하기: 전멸한 스테이지를 그대로 재도전한다. 목숨은 CONTINUE_LIVES, 런 점수는 일부 차감.
  private continueRun() {
    this.runScore = Math.round(this.runScore * CONTINUE_SCORE_KEEP);
    this.continues++;
    this.state.continues = this.continues;   // 클라 안내(남은 이어하기)용
    this.startRound(this.sim.level);    // 현재 스테이지 유지(진행 보존)
    this.sim.players.forEach((sp) => { sp.lives = CONTINUE_LIVES; });
    this.state.players.forEach((p) => { p.lives = CONTINUE_LIVES; });
  }

  // 이어하기 소진 후: 처음 스테이지부터 완전히 새 런(점수·버프·이어하기·목숨 초기화).
  private restartFromStart() {
    this.runScore = 0; this.continues = 0; this.state.continues = 0;
    this.scoreMult = 1; this.bonusLives = 0; this.boonStacks = {};
    this.sim.mods = freshMods();
    this.state.boons = ""; this.state.boonOffers = "";
    this.startRound(this.startLevel);
  }

  private makeEnemySchema(e: SimEnemy): Enemy {
    const es = new Enemy();
    es.x = e.x; es.y = e.y; es.kind = e.kind; es.shape = e.shape; es.r = e.r; es.aim = e.aim;
    return es;
  }

  tick(dt: number) {
    // 로비: 시작 카운트다운을 굴리고, 0이 되면 게임을 시작한다. (그 외엔 시뮬 정지)
    if (this.state.phase === "lobby") {
      if (this.state.startIn >= 0) {
        this.state.startIn = Math.max(0, this.state.startIn - dt / 1000);
        if (this.state.startIn <= 0) {
          if (this.state.players.size < 1) { this.state.startIn = -1; return; }  // 아무도 없으면 시작 보류
          this.beginGame();
        }
      }
      return;
    }
    // 버프 선택 화면(코옵): 5초 제한을 카운트다운하고, 시간이 다 되면 미선택자를 자동 선택시키고 진행한다.
    if (this.state.phase === "pick") {
      if (this.pickEndsAt > 0) {
        this.state.pickEndsIn = Math.max(0, (this.pickEndsAt - Date.now()) / 1000);
        if (Date.now() >= this.pickEndsAt) this.resolveStagePick();
      }
      return;   // 선택 중엔 시뮬 정지
    }
    // Stage cleared: stay on the celebration/reveal screen indefinitely so players can
    // enjoy the picture. No auto-advance — a player presses Enter to go on (see "restart").
    if (this.state.phase === "won") return;
    if (this.state.phase !== "playing") return;
    this.sim.update(dt / 1000);

    // sync only changed cells.
    // NOTE: use setAt(i, v), NOT cells[i] = v. The ArraySchema index-set proxy runs
    // `Array.from($items.keys())` on EVERY assignment (O(N), N=GRID_W*GRID_H=38400), so a
    // single large capture — which dumps thousands of cells into gridDirty in one tick —
    // costs O(cells * N) and freezes the sim loop for a frame (the "big-capture stutter").
    // setAt() bypasses the proxy and is O(1) per cell, so the cost is O(cells). (Same reason
    // startRound rebuilds with splice+push instead of index assignment.)
    for (const i of this.sim.gridDirty) this.state.cells.setAt(i, this.sim.grid[i]);
    for (const i of this.sim.trailDirty) this.state.trail.setAt(i, this.sim.trail[i]);
    for (const i of this.sim.webDirty) this.state.web.setAt(i, this.sim.web[i]);
    this.sim.gridDirty.clear();
    this.sim.trailDirty.clear();
    this.sim.webDirty.clear();

    // sync players
    this.sim.players.forEach((sp) => {
      const p = this.state.players.get(sp.sessionId);
      if (!p) return;
      p.x = sp.x; p.y = sp.y;
      p.drawing = sp.drawing ? 1 : 0;
      p.retreating = sp.retreating ? 1 : 0;
      p.boosting = sp.boosting ? 1 : 0;
      p.lives = sp.lives; p.claimed = sp.claimed; p.out = sp.out ? 1 : 0;
      p.traps = sp.traps; p.bonus = sp.bonus; p.stamina = sp.stamina;
      p.inv = sp.invuln > 0 ? 1 : 0;   // 무적 표시(마커 희미하게)
      p.shield = sp.shield;            // 방패 보유 수(마커 보호막 링)
      p.revP = sp.out && sp.revT > 0 ? Math.min(1, sp.revT / REVIVE_SEC) : 0;   // 부활 진행 링
    });

    // enemies can grow (reveal spawns) or shrink (captures) — match the list length
    while (this.state.enemies.length < this.sim.enemies.length)
      this.state.enemies.push(this.makeEnemySchema(this.sim.enemies[this.state.enemies.length]));
    while (this.state.enemies.length > this.sim.enemies.length)
      this.state.enemies.pop();
    for (let i = 0; i < this.sim.enemies.length; i++) {
      const se = this.sim.enemies[i]!, es = this.state.enemies[i]!;
      if (se.id == null) se.id = ++this.enemySeq;   // 최초 1회만 스탬프 → 배열이 재정렬돼도 id 유지
      es.id = se.id;
      es.x = se.x; es.y = se.y; es.aim = se.aim;
      es.r = se.r;   // 돌진 시 커진 덩치 등 크기 변화를 매 틱 반영
      // 격노 상태: 0 평상시, 1 격노(추격/질주/난사), 2 devour(포식) — 클라 시각 구분용
      es.enr = (se.boss && se.mode && se.mode !== "normal") ? (se.mode === "devour" ? 2 : 1) : 0;
      es.sh = se.shieldOn ? 1 : 0;   // shielder 무적 표시
      es.st = se.hidden ? 1 : 0;     // phantom 은신 표시
      es.hp = se.hp ?? 0; es.mhp = se.maxHp ?? 0;   // 데일리 보스 체력바

      if (es.kind !== se.kind) { es.kind = se.kind; es.shape = se.shape; }
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

    // beams: match length and copy endpoints/state
    while (this.state.beams.length < this.sim.beams.length) this.state.beams.push(new Beam());
    while (this.state.beams.length > this.sim.beams.length) this.state.beams.pop();
    for (let i = 0; i < this.sim.beams.length; i++) {
      const sb = this.sim.beams[i]!, es = this.state.beams[i]!;
      const [ax, ay, bx, by] = this.sim.beamEnds(sb);   // full 이면 양방향 관통 라인
      es.x1 = ax; es.y1 = ay; es.x2 = bx; es.y2 = by;
      es.w = sb.w; es.on = sb.tele > 0 ? 0 : 1;
    }

    // items: match length + position/kind
    while (this.state.items.length < this.sim.items.length) this.state.items.push(new Item());
    while (this.state.items.length > this.sim.items.length) this.state.items.pop();
    for (let i = 0; i < this.sim.items.length; i++) {
      const si = this.sim.items[i]!, es = this.state.items[i]!;
      es.x = si.x; es.y = si.y; if (es.kind !== si.kind) es.kind = si.kind;
      const b = si.blink ? 1 : 0; if (es.blink !== b) es.blink = b;
    }
    // missiles: match length + position
    while (this.state.missiles.length < this.sim.missiles.length) this.state.missiles.push(new Missile());
    while (this.state.missiles.length > this.sim.missiles.length) this.state.missiles.pop();
    for (let i = 0; i < this.sim.missiles.length; i++) {
      const sm = this.sim.missiles[i]!, es = this.state.missiles[i]!; es.x = sm.x; es.y = sm.y;
    }
    this.state.frozen = this.sim.freezeT > 0 ? 1 : 0;

    // broadcast capture events for client popups/sound, then clear
    if (this.sim.captureEvents.length) {
      for (const ev of this.sim.captureEvents) this.broadcast("trap", ev);
      this.sim.captureEvents.length = 0;
    }
    // 아이템 획득 연출 이벤트
    if (this.sim.itemEvents.length) {
      for (const ev of this.sim.itemEvents) this.broadcast("item", ev);
      this.sim.itemEvents.length = 0;
    }
    // 동료 부활 연출 이벤트
    if (this.sim.reviveEvents.length) {
      for (const ev of this.sim.reviveEvents) this.broadcast("revive", ev);
      this.sim.reviveEvents.length = 0;
    }
    // 수호 버프 발동 연출(죽음 무효)
    if (this.sim.guardEvents.length) {
      for (const ev of this.sim.guardEvents) this.broadcast("guard", ev);
      this.sim.guardEvents.length = 0;
    }
    // 보스 맵 파괴 → 3D 돌 파편 연출(클라 shatter3d)
    if (this.sim.shatterEvents.length) {
      for (const ev of this.sim.shatterEvents) this.broadcast("shatter", ev);
      this.sim.shatterEvents.length = 0;
    }
    // 플레이어 사망 → 마커 산산조각 + 데미지 비네트/히트스톱(클라)
    if (this.sim.deathEvents.length) {
      for (const ev of this.sim.deathEvents) this.broadcast("death", ev);
      this.sim.deathEvents.length = 0;
    }
    // 영역 점유(맵 밝힘) → 검은 돌 파편(클라 shatter3d, 검은색)
    if (this.sim.revealEvents.length) {
      for (const ev of this.sim.revealEvents) this.broadcast("reveal", ev);
      this.sim.revealEvents.length = 0;
    }
    // 데일리 보스 처치 → 대폭발 + 슬로우모 + 점수 샤워(클라)
    if (this.sim.bossDefeatEvents.length) {
      for (const ev of this.sim.bossDefeatEvents) this.broadcast("bossDefeat", ev);
      this.sim.bossDefeatEvents.length = 0;
    }

    // 블랙홀 예고 이벤트 → 클라이언트가 그 자리에 블랙홀을 띄워 회피를 유도
    if (this.sim.warpEvents.length) {
      for (const ev of this.sim.warpEvents) this.broadcast("warp", ev);
      this.sim.warpEvents.length = 0;
    }

    this.state.claimedInterior = this.sim.claimedInterior;
    this.state.bossIn = this.sim.bossIn;   // 보스 카운트다운 (≤10s면 클라가 WARNING 표시)
    if (this.sim.over) {
      this.state.phase = this.sim.over;   // "won" | "lost"
      if (this.sim.over === "won") this.onStageCleared();
      else if (this.sim.over === "lost") {
        this.recordBests({ score: this.runScore });   // 사망 시점의 런 점수(피크) 기록
        this.submitDailyScores();                      // 데일리면 최종 점수 랭킹 제출
      }
    }
  }

  // 서버 권위 도감 기록: 방에 있는 로그인 플레이어 전원에게 현재 스테이지 그림을 unlock.
  // (클라이언트는 DB 쓰기 권한이 없어 위조 불가 — RLS 로 막힘)
  // 스테이지 클리어 처리(실제 승리 + dev "스테이지 완료" 공통): 점수 계산·누적, 다음 그림 예고,
  // 도감/최고기록 기록. phase="won" 전환은 호출부에서 한다.
  private onStageCleared() {
    const clearMs = Date.now() - this.roundStartMs;
    const stageScore = this.computeStageScore(clearMs);
    this.runScore += stageScore;
    this.state.clearMs = clearMs;
    this.state.stageScore = stageScore;
    this.state.runScore = this.runScore;
    this.state.nextIn = 0;   // no countdown — wait for a player's Enter
    this.state.nextImageId = this.imageAt(this.sim.level + 1);   // 다음 스테이지 그림 미리 로드
    this.grantUnlocks();     // 서버 권위: 실제 클리어했을 때만 도감 기록
    // 계정 최고기록: 이 스테이지 클리어 시간(최소)·도달 스테이지(최대)·런 점수(최대)
    this.recordBests({ timeMs: clearMs, stage: this.sim.level, score: this.runScore });
    this.submitDailyScores();   // 데일리면 매 클리어마다 현재 점수(최고만 반영) 제출
    // 버프 선택은 이 클리어 화면이 아니라 "다음 스테이지 시작 화면"에서 한다(beginStagePick).
  }

  // 클리어 화면에서 Enter → 다음 스테이지의 "시작 화면": 각자 버프를 고르면(선택이 스테이지에
  // 적용된 채로) 스테이지가 생성된다. phase="pick" 동안 tick 은 시뮬을 돌리지 않아 화면이 멈춘다.
  // 코옵(2인 이상)은 5초 제한을 걸어(한 명이 오래 끌지 않게) 시간이 다 되면 미선택자를 자동 선택시킨다.
  private beginStagePick() {
    this.state.phase = "pick";
    this.offerBoons();
    if (this.state.players.size >= 2) { this.pickEndsAt = Date.now() + PICK_SECS * 1000; this.state.pickEndsIn = PICK_SECS; }
    else { this.pickEndsAt = 0; this.state.pickEndsIn = -1; }   // 솔로는 제한 없음(느긋하게)
  }

  // 데일리 챌린지 랭킹 제출: 방의 로그인 플레이어들의 현재 런 점수를 그날 보드로 제출(최고만 반영).
  private submitDailyScores() {
    if (!this.isDaily) return;
    for (const [sid, uid] of this.userIds) {
      const p = this.state.players.get(sid);
      submitDaily(uid, p?.name || "", this.dailyDay, this.runScore, this.state.level, this.state.clearMs || null);
    }
  }

  // 스테이지 클리어 점수 = 깊이 + 점유율 + 포획수 + (기존)포획보너스 + 속도 보너스.
  private computeStageScore(clearMs: number): number {
    let traps = 0, bonus = 0;
    this.sim.players.forEach((p) => { traps += p.traps; bonus += p.bonus; });
    const ratio = this.sim.claimedInterior / Math.max(1, this.sim.totalInterior);
    const speed = Math.max(0, Math.round(SCORE_SPEED_BASE - (clearMs / 1000) * SCORE_SPEED_DROP));
    const base = this.sim.level * SCORE_LEVEL + ratio * SCORE_COVER + traps * SCORE_TRAP + bonus + speed;
    return Math.round(base * this.scoreMult);   // 로그라이트 "점수" 버프 배수 적용
  }

  // 로그인 플레이어들의 계정 최고기록 갱신(서버 권위). 값이 없거나 테이블(SQL) 미준비면 조용히 스킵.
  private recordBests(rec: { timeMs?: number; stage?: number; score?: number }) {
    for (const uid of this.userIds.values()) recordBest(uid, rec);
  }

  private grantUnlocks() {
    const imageId = this.state.imageId;
    if (!imageId) return;
    for (const uid of this.userIds.values()) recordUnlock(uid, imageId);
  }

  // 클라이언트가 보낸 레벨을 1..99 정수로 정규화. 유효하지 않으면 1.
  private clampLevel(v: unknown): number {
    const n = Math.floor(Number(v));
    if (!Number.isFinite(n)) return 1;
    return Math.max(1, Math.min(99, n));
  }

  // 스테이지 배경 이미지를 랜덤 순서로 배정하되, 풀(IMAGE_POOL) 한 바퀴 동안은 겹치지 않게 한다.
  // 소진되면 다시 셔플해 이어 붙이고, 이음새에서 직전 이미지와 연속으로 겹치지 않도록 한다.
  private imageAt(level: number): string {
    while (this.imageSeq.length < level) {
      const pool = IMAGE_POOL.slice();
      for (let i = pool.length - 1; i > 0; i--) {   // Fisher-Yates 셔플
        const j = Math.floor(Math.random() * (i + 1));
        [pool[i], pool[j]] = [pool[j], pool[i]];
      }
      const last = this.imageSeq[this.imageSeq.length - 1];   // 이음새 연속 중복 방지
      if (last && pool.length > 1 && pool[0] === last) [pool[0], pool[1]] = [pool[1], pool[0]];
      this.imageSeq.push(...pool);
    }
    return this.imageSeq[level - 1];
  }

  private freeSlot(): number {
    const used = new Set<number>();
    this.sim.players.forEach((p) => used.add(p.owner));
    for (let s = 1; s <= MAX_PLAYERS; s++) if (!used.has(s)) return s;
    return 1;
  }

  onJoin(client: Client, options: { name?: string; token?: string; skin?: string }) {
    const slot = this.freeSlot();
    const sp = this.sim.addPlayer(client.sessionId, slot);

    const p = new Player();
    p.id = client.sessionId;
    p.name = options?.name || `P${slot}`;
    p.color = COLORS[(slot - 1) % COLORS.length];
    // 마커 스킨: 클라가 보낸 id 를 그대로 저장(다른 플레이어에게도 브로드캐스트). 안전한 짧은
    // 문자열만 허용(영숫자·_-, 24자 이하), 없으면 기본 "dot". 검증은 화면 표시용이라 가벼움.
    { const s = String(options?.skin ?? ""); p.skin = /^[a-zA-Z0-9_-]{1,24}$/.test(s) ? s : "dot"; }
    p.owner = slot;
    p.x = sp.x; p.y = sp.y; p.lives = sp.lives;
    this.state.players.set(client.sessionId, p);

    // 로그인 토큰 검증(비동기) → 성공하면 도감 기록 대상에 등록. 위조 토큰은 무시된다.
    if (options?.token) {
      verifyToken(options.token).then((uid) => {
        if (uid && this.state.players.has(client.sessionId)) this.userIds.set(client.sessionId, uid);
      });
    }

    // 데일리 챌린지: 솔로 즉시 시작(로비 대기 없음).
    if (this.isDaily && this.state.phase === "lobby" && this.state.startIn < 0) {
      this.state.startIn = 1;
    }
    // 빠른 참가(공개) 방: 첫 입장부터 짧은 카운트다운으로 자동 시작 → 혼자여도 로비에서 멈추지 않는다.
    // 그 사이 다른 빠른참가 유저가 합류하면 같은 방에서 함께 시작(즉시 시작 + 협동 매칭 양립).
    else if (!this.isPrivate && this.state.phase === "lobby" && this.state.startIn < 0) {
      this.state.startIn = QUICK_START_SECS;
    }
    // 비공개 방: 로비가 꽉 차면(4명) 10초 카운트다운 후 자동 시작.
    else if (this.state.phase === "lobby" && this.state.startIn < 0 && this.state.players.size >= MAX_PLAYERS) {
      this.state.startIn = 10;
    }
  }

  onLeave(client: Client) {
    this.sim.removePlayer(client.sessionId);
    this.state.players.delete(client.sessionId);
    this.userIds.delete(client.sessionId);
  }
}
