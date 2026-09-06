// 간단한 효과음. 오디오 파일 없이 WebAudio 로 합성한다. (브라우저 정책상 사용자 클릭 후 initAudio 필요)
let ctx = null, muted = false;
try { muted = localStorage.getItem("galspanic:muted") === "1"; } catch {}

function ac() {
  if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch {} }
  return ctx;
}
export function initAudio() { const c = ac(); if (c && c.state === "suspended") c.resume(); }
export function isMuted() { return muted; }
export function setMuted(m) { muted = !!m; try { localStorage.setItem("galspanic:muted", muted ? "1" : "0"); } catch {} }

// 한 음 (freq Hz, t0 지연초, dur 길이초)
function tone(freq, t0, dur, type = "triangle", gain = 0.18) {
  const c = ac(); if (!c || muted) return;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.value = freq;
  o.connect(g); g.connect(c.destination);
  const s = c.currentTime + t0;
  g.gain.setValueAtTime(0.0001, s);
  g.gain.linearRampToValueAtTime(gain, s + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
  o.start(s); o.stop(s + dur + 0.02);
}

// 몬스터 포획: 밝은 블립 (많이 잡을수록 음높이↑)
export function sfxCapture(count = 1) {
  const base = 520 + Math.min(count, 6) * 55;
  tone(base, 0, 0.12, "triangle", 0.16);
  tone(base * 1.5, 0.045, 0.12, "sine", 0.11);
}
// 스테이지 클리어: 상승 아르페지오 (C-E-G-C) + 반짝
export function sfxClear() {
  [523, 659, 784, 1047].forEach((f, i) => tone(f, i * 0.12, 0.5, "triangle", 0.17));
  tone(1568, 0.5, 0.6, "sine", 0.11);
}
// 아이템 획득(파워업): 짧게 위로 튀는 두 음 블립 (클리어보다 가볍게)
export function sfxItem() {
  tone(660, 0, 0.09, "square", 0.12);
  tone(990, 0.06, 0.14, "triangle", 0.14);
}
// 게임 오버: 하강 톤
export function sfxGameover() {
  [440, 392, 330, 262].forEach((f, i) => tone(f, i * 0.16, 0.5, "sawtooth", 0.13));
}

// 재사용 화이트노이즈 버퍼(부서지는 소리 재료)
let noiseBuf = null;
function noise() {
  const c = ac(); if (!c) return null;
  if (!noiseBuf) { const n = (c.sampleRate * 0.5) | 0; noiseBuf = c.createBuffer(1, n, c.sampleRate); const d = noiseBuf.getChannelData(0); for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1; }
  return noiseBuf;
}
// 맵 점유(밝힘) 시 "부서지는" 소리. n(부순 셀 수)이 클수록 더 낮고·길고·묵직하게(럼블) — 규모별로 다양.
export function sfxShatter(n) {
  const c = ac(); if (!c || muted) return;
  const size = Math.max(1, n || 1), big = Math.min(1, size / 1400), t0 = c.currentTime, nb = noise();
  if (!nb) return;
  const grains = Math.round(2 + big * 7);   // 작은 크랙 여러 개 (규모 클수록 많이)
  for (let i = 0; i < grains; i++) {
    const src = c.createBufferSource(); src.buffer = nb;
    const bp = c.createBiquadFilter(); bp.type = "bandpass";
    bp.frequency.value = (420 + Math.random() * 2200) * (1 - big * 0.62);   // 규모 크면 더 저음
    bp.Q.value = 0.7 + Math.random();
    const g = c.createGain();
    const s = t0 + i * (0.014 + Math.random() * 0.03 * (1 + big));
    const dur = 0.05 + Math.random() * (0.09 + big * 0.16);
    const gain = (0.11 + 0.10 * big) / Math.sqrt(grains);
    g.gain.setValueAtTime(0.0001, s); g.gain.linearRampToValueAtTime(gain, s + 0.004); g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
    src.connect(bp); bp.connect(g); g.connect(c.destination); src.start(s); src.stop(s + dur + 0.02);
  }
  if (big > 0.22) {   // 큰 점유: 무너지는 저음 럼블
    const src = c.createBufferSource(); src.buffer = nb;
    const lp = c.createBiquadFilter(); lp.type = "lowpass"; lp.frequency.value = 170 + big * 130;
    const g = c.createGain(); const dur = 0.22 + big * 0.55;
    g.gain.setValueAtTime(0.0001, t0); g.gain.linearRampToValueAtTime(0.09 + 0.12 * big, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(lp); lp.connect(g); g.connect(c.destination); src.start(t0); src.stop(t0 + dur + 0.05);
  }
  tone(70 + Math.random() * 40, 0, 0.09, "square", 0.09 + 0.06 * big);   // 임팩트 "탁"
}

// ── 배경음악(BGM) ── 오디오 파일 없이 WebAudio 로 합성. 상황별 "모드"로 곡이 바뀐다:
//   play = 평소(여러 곡 순환), boss = 보스전(무겁고 빠른 긴장), win = 클리어(밝은 축하).
// 각 트랙: step(음 길이), prog(코드별 bass+arp 4음), 파형/음량, sparkle(옥타브 반짝), bassEveryBeat(구동 베이스),
// lead(리드 멜로디, 루프 길이만큼의 음 배열), leadType/leadGain. 곡은 아래 song() 헬퍼로 만든다.
// 음이름 → 주파수 (C1..B6). "R" = 쉼표(0). 긴 멜로디를 읽기 쉽게 적기 위한 도우미.
const NOTE = { R: 0 };
(function () { const nm = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  for (let o = 1; o <= 6; o++) for (let i = 0; i < 12; i++) NOTE[nm[i] + o] = 440 * Math.pow(2, (o * 12 + i - 57) / 12); })();
const seq = (arr) => arr.map((n) => NOTE[n] || 0);
// 코드 진행(chords) + 코드별 아르페지오(arps) + 리드 멜로디(lead)로 한 곡을 만든다(전부 음이름).
function song(step, chords, roots, arps, lead, opts) {
  const A = {}; for (const k in arps) A[k] = seq(arps[k]);
  const prog = chords.map((c, i) => ({ bass: NOTE[roots[i]] || 0, arp: A[c] }));
  return Object.assign({ step, prog, sparkle: true, bassEveryBeat: false,
    bassType: "triangle", arpType: "sine", bassGain: 0.05, arpGain: 0.028,
    lead: seq(lead), leadType: "sine", leadGain: 0.03 }, opts || {});
}

const BGM_SETS = {
  play: [
    // 잔잔한 팝 (32마디, A-B-A'-C 4섹션). 흐르는 멜로디가 계속 전개되어 오래 들어도 덜 반복된다.
    song(0.26,
      ["Am","F","C","G","Am","F","G","Am", "Dm","G","Em","Am","F","C","Dm","E", "Am","F","C","G","Am","Dm","G","Am", "F","C","G","Am","Dm","G","C","G"],
      ["A2","F2","C3","G2","A2","F2","G2","A2", "D3","G2","E2","A2","F2","C3","D3","E2", "A2","F2","C3","G2","A2","D3","G2","A2", "F2","C3","G2","A2","D3","G2","C3","G2"],
      { Am:["A3","C4","E4","C4"], F:["F3","A3","C4","A3"], C:["C4","E4","G4","E4"], G:["G3","B3","D4","B3"], Dm:["D3","F3","A3","F3"], Em:["E3","G3","B3","G3"], E:["E3","G#3","B3","G#3"] },
      ["E4","A4","C5","B4","A4","C5","A4","F4","G4","E4","G4","C5","B4","D5","B4","G4",
       "A4","R","E4","A4","C5","A4","F4","A4","D5","B4","G4","B4","A4","R","C5","E4",
       "F4","A4","D5","A4","B4","D5","G5","D5","E4","G4","B4","G4","A4","C5","E5","C5",
       "A4","F4","A4","C5","G4","C5","E5","C5","F4","A4","D5","F5","E5","D5","B4","G#4",
       "A4","E5","C5","A4","F4","A4","C5","A4","E4","G4","C5","E5","D5","B4","G4","D5",
       "C5","A4","E4","A4","D5","F4","A4","D5","G4","B4","D5","G5","A5","E5","C5","A4",
       "A4","C5","F5","C5","G4","C5","E5","G5","D5","G5","B4","D5","C5","E5","A4","C5",
       "A4","D5","F5","D5","B4","D5","G4","B4","C5","G4","E4","G4","G4","R","D5","R"]),
    // 경쾌한 칩튠 (32마디, 빠름·square). 밝고 통통 튀는 멜로디가 폭넓게 오르내린다.
    song(0.17,
      ["C","G","Am","F","C","G","F","C", "Am","F","C","G","Dm","G","C","E", "F","C","G","Am","F","G","Em","Am", "C","G","Am","F","Dm","G","C","G"],
      ["C3","G2","A2","F2","C3","G2","F2","C3", "A2","F2","C3","G2","D3","G2","C3","E2", "F2","C3","G2","A2","F2","G2","E2","A2", "C3","G2","A2","F2","D3","G2","C3","G2"],
      { C:["C4","E4","G4","E4"], G:["G3","B3","D4","B3"], Am:["A3","C4","E4","C4"], F:["F3","A3","C4","A3"], Dm:["D3","F3","A3","F3"], Em:["E3","G3","B3","G3"], E:["E3","G#3","B3","G#3"] },
      ["C5","E5","G5","E5","B4","D5","G5","D5","A4","C5","E5","C5","F4","A4","C5","A4",
       "E5","C5","G4","C5","D5","B4","G4","B4","C5","A4","F4","A4","C5","R","E5","G5",
       "A4","E5","C5","A4","C5","A4","F4","C5","E5","G5","C6","G5","D5","G5","B5","G5",
       "A4","D5","F5","D5","B4","D5","G5","B5","C6","G5","E5","C5","B4","E5","G#5","E5",
       "A4","C5","F5","A5","G5","E5","C5","G4","B4","D5","G5","D5","C5","E5","A5","E5",
       "A4","F5","C5","A4","B4","G5","D5","B4","E5","G5","B5","G5","A5","E5","C5","A4",
       "G4","C5","E5","G5","D5","G5","B4","D5","E5","C5","A4","C5","F5","C5","A4","F4",
       "D5","F5","A4","D5","G5","D5","B4","G4","E5","G5","C5","E5","D5","R","G4","R"],
      { arpType:"square", leadType:"square", leadGain:0.028, bassGain:0.045 }),
    // 몽환 (32마디, 느리고 높음·여백 많음). 고음 sine 멜로디가 아득하게 떠다닌다.
    song(0.34,
      ["C","Am","F","G","Am","F","C","G", "F","C","Dm","Am","G","Em","Am","F", "C","G","Am","Em","F","Dm","G","C", "Am","F","C","G","Dm","Em","F","G"],
      ["C3","A2","F2","G2","A2","F2","C3","G2", "F2","C3","D3","A2","G2","E2","A2","F2", "C3","G2","A2","E2","F2","D3","G2","C3", "A2","F2","C3","G2","D3","E2","F2","G2"],
      { C:["E4","G4","C5","G4"], Am:["E4","A4","C5","A4"], F:["F4","A4","C5","A4"], G:["G4","B4","D5","B4"], Dm:["F4","A4","D5","A4"], Em:["G4","B4","E5","B4"] },
      ["G5","R","E5","R","A5","R","E5","R","C6","R","A5","R","B5","R","D6","R",
       "E5","R","A5","R","F5","R","C6","R","E5","R","G5","R","D5","R","B4","R",
       "A5","R","F5","R","C6","R","G5","R","D6","R","A5","R","E5","R","C6","R",
       "D6","R","B5","R","E5","R","B5","R","A5","R","E5","R","C6","R","A5","R",
       "E6","R","C6","R","D6","R","G5","R","C6","R","A5","R","B5","R","G5","R",
       "A5","R","F5","R","D5","R","A5","R","B5","R","D6","R","C6","R","G5","R",
       "E5","R","A5","R","F5","R","C6","R","G5","R","E5","R","D5","R","G5","R",
       "F5","R","D5","R","G5","R","E5","R","A5","R","F5","R","D5","R","B4","R"],
      { bassType:"sine", leadGain:0.026, bassGain:0.045 }),
  ],
  boss: [
    // 무겁고 빠른 긴장감 — 16마디(약 9초) 짜리 다크 보스 테마. 낮은 구동 베이스(구동감) + 은은한 화음 아르페지오
    // + 계속 전개되는 리드 멜로디(A단조/화성단조 G#)로 반복감을 줄였다. (A섹션 1~8마디, B섹션 9~16마디 클라이맥스)
    (function () {
      const CH = {   // 코드별 아르페지오(4음) — 조용한 화음 배경
        Am: seq(["A3", "C4", "E4", "C4"]), F: seq(["F3", "A3", "C4", "A3"]), G: seq(["G3", "B3", "D4", "B3"]),
        E: seq(["E3", "G#3", "B3", "G#3"]), C: seq(["C4", "E4", "G4", "E4"]), Dm: seq(["D3", "F3", "A3", "F3"]),
      };
      const chords = ["Am","Am","F","G","Am","Am","E","E","Am","C","F","G","Dm","E","Am","E",
                      "Am","Am","F","G","Am","F","Dm","E","C","G","Dm","E","Am","F","E","Am"];
      const roots = seq(["A1","A1","F1","G1","A1","A1","E1","E1","A1","C2","F1","G1","D2","E1","A1","E1",
                         "A1","A1","F1","G1","A1","F1","D2","E1","C2","G1","D2","E1","A1","F1","E1","A1"]);
      const prog = chords.map((c, i) => ({ bass: roots[i], arp: CH[c] }));
      const lead = seq([
        "A4","R","C5","B4","A4","R","E4","R","F4","A4","C5","A4","G4","B4","D5","B4",       // 1~4
        "E5","R","D5","C5","B4","A4","R","E4","G#4","B4","E5","B4","G#4","R","E4","R",        // 5~8
        "A4","C5","E5","C5","E5","G5","E5","C5","F5","R","E5","C5","D5","G5","B5","G5",       // 9~12
        "F5","D5","A4","D5","G#4","B4","E5","G#5","A5","R","E5","C5","B4","G#4","E4","R",     // 13~16
        "A5","E5","C5","A4","E5","C5","A4","E4","F5","C5","A4","F4","G5","D5","B4","G4",       // 17~20
        "A5","R","E5","C5","F5","A4","C5","F5","D5","F5","A5","F5","G#5","E5","B4","G#4",      // 21~24
        "C5","E5","G5","C6","B5","G5","D5","B4","A5","F5","D5","A4","G#4","B4","E5","G#5",     // 25~28
        "A5","E5","A4","C5","C6","A5","F5","C5","B5","G#5","E5","B4","A4","R","E4","R",        // 29~32
      ]);
      return { step: 0.14, prog, bassType: "sawtooth", arpType: "triangle", bassGain: 0.055, arpGain: 0.016,
               sparkle: false, bassEveryBeat: true, lead, leadType: "square", leadGain: 0.05 };
    })(),
  ],
  win: [
    // 밝고 당당한 승리 팡파레 — 8마디(약 6초). C장조 상행 진행 + 트라이엄펀트 리드 멜로디(고음 C6 로 클라이맥스)
    // + 옥타브 반짝임으로 축하 분위기. (C–G–Am–F / C–F–G–C)
    (function () {
      const CH = {
        C: seq(["C4", "E4", "G4", "C5"]), G: seq(["G4", "B4", "D5", "B4"]),
        Am: seq(["A4", "C5", "E5", "C5"]), F: seq(["F4", "A4", "C5", "A4"]),
      };
      const chords = ["C","G","Am","F","C","F","G","C","F","C","G","Am","F","G","C","C"];
      const roots = seq(["C3","G2","A2","F2","C3","F2","G2","C3","F2","C3","G2","A2","F2","G2","C3","C3"]);
      const prog = chords.map((c, i) => ({ bass: roots[i], arp: CH[c] }));
      const lead = seq([
        "G4","C5","E5","G5","D5","G5","B5","G5","C5","E5","A5","E5","C5","F5","A5","F5",   // 1~4
        "E5","G5","C6","G5","A5","F5","C5","A4","B4","D5","G5","B5","C6","R","G5","E5",     // 5~8
        "A5","C6","F5","A5","G5","E5","C5","G5","D5","G5","B5","D5","C5","E5","A5","C6",     // 9~12
        "A5","F5","C5","A4","B4","D5","G5","B5","C6","E6","G6","E6","C6","G5","E5","C5",     // 13~16
      ]);
      return { step: 0.19, prog, bassType: "triangle", arpType: "triangle", bassGain: 0.05, arpGain: 0.03,
               sparkle: true, bassEveryBeat: false, lead, leadType: "square", leadGain: 0.045 };
    })(),
  ],
};
let bgmOn = false, bgmTimer = 0, bgmNext = 0, bgmStep = 0, bgmMode = "off", bgmSet = null, bgmTrackIdx = 0;
function bgmNote(freq, s, dur, type, gain) {
  const c = ac(); if (!c || muted) return;
  const o = c.createOscillator(), g = c.createGain();
  o.type = type; o.frequency.value = freq; o.connect(g); g.connect(c.destination);
  g.gain.setValueAtTime(0.0001, s);
  g.gain.linearRampToValueAtTime(gain, s + 0.03);
  g.gain.exponentialRampToValueAtTime(0.0001, s + dur);
  o.start(s); o.stop(s + dur + 0.03);
}
const BGM_SLOW = 1.5;   // 전역 배속(음 길이 배수). 클수록 느림. 여기 한 곳에서 전체 템포 조절.
function bgmSchedule() {
  const c = ac(); if (!c || !bgmOn || !bgmSet) return;
  while (bgmNext < c.currentTime + 0.35) {   // 0.35초 앞까지 미리 예약(끊김 방지)
    const tk = bgmSet[bgmTrackIdx], npl = tk.prog.length * 4, ls = bgmStep % npl, st = tk.step * BGM_SLOW;
    const bar = Math.floor(ls / 4) % tk.prog.length, beat = ls % 4, ch = tk.prog[bar];
    if (tk.bassEveryBeat) bgmNote(ch.bass, bgmNext, st * 0.9, tk.bassType, tk.bassGain);   // 매 박 구동 베이스(긴장)
    else if (beat === 0) bgmNote(ch.bass, bgmNext, st * 4 * 0.95, tk.bassType, tk.bassGain); // 한 마디 지속 베이스
    bgmNote(ch.arp[beat], bgmNext, st * 0.85, tk.arpType, tk.arpGain);
    if (tk.sparkle && beat === 2) bgmNote(ch.arp[beat] * 2, bgmNext, st * 0.5, "sine", tk.arpGain * 0.45);
    if (tk.lead && tk.lead[ls]) bgmNote(tk.lead[ls], bgmNext, st * 0.9, tk.leadType, tk.leadGain);   // 리드 멜로디
    bgmStep++; bgmNext += st;
    if (bgmStep >= npl * 2 && bgmSet.length > 1) { bgmStep = 0; bgmTrackIdx = (bgmTrackIdx + 1) % bgmSet.length; }  // 2루프마다 같은 모드 내 다음 곡
  }
}
// 상황에 맞는 음악으로 전환("play"/"boss"/"win"/"off"). 같은 모드면 무시. 끊김 없이 다음 마디부터 새 곡.
export function setBgmMode(mode) {
  if (mode === bgmMode) return;
  bgmMode = mode;
  if (mode === "off") { bgmOn = false; if (bgmTimer) { clearInterval(bgmTimer); bgmTimer = 0; } return; }
  bgmSet = BGM_SETS[mode] || BGM_SETS.play;
  bgmTrackIdx = Math.floor(Math.random() * bgmSet.length);
  bgmStep = 0;
  const c = ac();
  if (c && !bgmOn) { bgmOn = true; bgmNext = c.currentTime + 0.05; bgmSchedule(); bgmTimer = setInterval(bgmSchedule, 80); }
}
export function startBgm() { setBgmMode("play"); }
export function stopBgm() { setBgmMode("off"); }
