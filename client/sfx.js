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
// 각 트랙: step(음 길이), prog(코드별 bass+arp 4음), 파형/음량, sparkle(옥타브 반짝), bassEveryBeat(구동 베이스).
function trk(step, prog, bassType, arpType, bassGain, arpGain, sparkle, bassEveryBeat) {
  return { step, prog, bassType, arpType, bassGain, arpGain, sparkle, bassEveryBeat };
}
const BGM_SETS = {
  play: [
    // 잔잔한 팝 (Am–F–C–G)
    trk(0.30, [{bass:110.00,arp:[220.00,261.63,329.63,261.63]},{bass:87.31,arp:[174.61,220.00,261.63,220.00]},
               {bass:130.81,arp:[261.63,329.63,392.00,329.63]},{bass:98.00,arp:[196.00,246.94,293.66,246.94]}],
        "triangle","sine",0.05,0.032,true,false),
    // 경쾌한 칩튠 (C–G–Am–F, 빠름)
    trk(0.20, [{bass:130.81,arp:[261.63,329.63,392.00,329.63]},{bass:98.00,arp:[246.94,293.66,392.00,293.66]},
               {bass:110.00,arp:[220.00,261.63,329.63,261.63]},{bass:87.31,arp:[174.61,220.00,261.63,220.00]}],
        "triangle","square",0.045,0.026,true,false),
    // 몽환 (C–Am–F–G, 높고 느긋)
    trk(0.36, [{bass:130.81,arp:[329.63,392.00,523.25,392.00]},{bass:110.00,arp:[329.63,440.00,523.25,440.00]},
               {bass:87.31,arp:[349.23,440.00,523.25,440.00]},{bass:98.00,arp:[392.00,493.88,587.33,493.88]}],
        "sine","sine",0.045,0.03,true,false),
  ],
  boss: [
    // 무겁고 빠른 긴장 (Am–G–F–E 하강, 낮은 구동 베이스 + 빠른 템포)
    trk(0.15, [{bass:55.00,arp:[220.00,261.63,329.63,220.00]},{bass:49.00,arp:[196.00,246.94,293.66,196.00]},
               {bass:43.65,arp:[174.61,220.00,261.63,174.61]},{bass:41.20,arp:[207.65,246.94,329.63,207.65]}],
        "sawtooth","square",0.06,0.03,false,true),
  ],
  win: [
    // 밝은 축하 팡파레 (C–F–G–C, 상행)
    trk(0.20, [{bass:130.81,arp:[261.63,329.63,392.00,523.25]},{bass:174.61,arp:[349.23,440.00,523.25,440.00]},
               {bass:196.00,arp:[392.00,493.88,587.33,493.88]},{bass:261.63,arp:[523.25,659.25,783.99,659.25]}],
        "triangle","triangle",0.05,0.034,true,false),
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
function bgmSchedule() {
  const c = ac(); if (!c || !bgmOn || !bgmSet) return;
  while (bgmNext < c.currentTime + 0.35) {   // 0.35초 앞까지 미리 예약(끊김 방지)
    const tk = bgmSet[bgmTrackIdx], npl = tk.prog.length * 4, ls = bgmStep % npl;
    const bar = Math.floor(ls / 4) % tk.prog.length, beat = ls % 4, ch = tk.prog[bar];
    if (tk.bassEveryBeat) bgmNote(ch.bass, bgmNext, tk.step * 0.9, tk.bassType, tk.bassGain);   // 매 박 구동 베이스(긴장)
    else if (beat === 0) bgmNote(ch.bass, bgmNext, tk.step * 4 * 0.95, tk.bassType, tk.bassGain); // 한 마디 지속 베이스
    bgmNote(ch.arp[beat], bgmNext, tk.step * 0.85, tk.arpType, tk.arpGain);
    if (tk.sparkle && beat === 2) bgmNote(ch.arp[beat] * 2, bgmNext, tk.step * 0.5, "sine", tk.arpGain * 0.45);
    bgmStep++; bgmNext += tk.step;
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
