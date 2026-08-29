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
// 게임 오버: 하강 톤
export function sfxGameover() {
  [440, 392, 330, 262].forEach((f, i) => tone(f, i * 0.16, 0.5, "sawtooth", 0.13));
}
