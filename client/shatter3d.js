// 보스가 맵(점유지)을 부술 때, 그 자리에 "돌·바위 파편이 터져 흩어지는" 효과를 three.js 로 낸다.
// 게임은 512x768 고정 좌표계의 2D 캔버스(#c) 위에서 돌아가므로, 여기서도 같은 좌표계를 쓰는
// 오소(orthographic) 카메라를 만들어 오버레이 캔버스(#fx3dShatter)를 #c 위에 정확히 겹친다.
// spawnShatter(sx, sy, ...) 의 sx/sy 는 이미 카메라(팔로우/줌/흔들림)가 반영된 512x768 화면 좌표.
import * as THREE from "./vendor/three.module.min.js";

const WORLD_W = 512, WORLD_H = 768;        // 게임 캔버스(#c)의 고정 백버퍼 좌표계
const MAX_CHUNKS = 180;                     // 동시 파편 상한(성능 보호)
const GRAV = 2200;                          // 중력(px/s², y-아래로 +)
const ROCK_COLORS = [0x8b8378, 0x6f727a, 0x5b5e66, 0x9a8b76, 0x767a80, 0x847c6e];
// 점유(맵 밝힘) 파편은 "검은 돌 껍질" — 아주 어두운 색(빛 받는 면만 어둑하게 보여 그림 위/보드 위 모두 잘 보임)
const DARK_COLORS = [0x1b1b21, 0x24222a, 0x2b2620, 0x201d1a, 0x18191d];

let renderer, scene, camera;
let inited = false, supported = false;
let geos = [];                              // 울퉁불퉁하게 변형한 바위 지오메트리 몇 종
let pool = [];                              // { mesh, mat, vx,vy,vz, ax,ay,az, ttl, life, active }
let bosses = new Map();                     // id → { group, spinner, core, coreMat, eyes[], enr, seenAt } (3D 보스)
let gameCanvas = null, overlay = null;
let lastRect = { l: -1, t: -1, w: -1, h: -1 };

// 정이십면체 정점을 무작위로 밀어 바위처럼 각지게 만든다(면 음영이 살아나게 flatShading 과 함께).
function makeRockGeo(seed) {
  const g = new THREE.IcosahedronGeometry(1, 0);
  const pos = g.attributes.position;
  let s = seed * 9301 + 49297;
  const rnd = () => { s = (s * 9301 + 49297) % 233280; return s / 233280; };
  for (let i = 0; i < pos.count; i++) {
    const f = 0.72 + rnd() * 0.55;         // 0.72~1.27 배로 정점 반경을 흩뜨림
    pos.setXYZ(i, pos.getX(i) * f, pos.getY(i) * f, pos.getZ(i) * f);
  }
  g.computeVertexNormals();
  return g;
}

function initOnce() {
  if (inited) return supported;
  inited = true;
  try {
    gameCanvas = document.getElementById("c");
    overlay = document.getElementById("fx3dShatter");
    if (!gameCanvas || !overlay) return (supported = false);
    renderer = new THREE.WebGLRenderer({ canvas: overlay, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setClearColor(0x000000, 0);
    scene = new THREE.Scene();
    // 오소 카메라: 좌표 0..512(가로), 0..768(세로), y 는 화면처럼 아래로 증가(top=0, bottom=768).
    camera = new THREE.OrthographicCamera(0, WORLD_W, 0, WORLD_H, 0.1, 4000);
    camera.position.set(0, 0, 1000);        // -Z 를 바라봄(기본). 파편은 z≈0 부근.

    // 3점 조명 + 림 라이트 → 입체감 있는 "렌더링된" 느낌 (대비를 위해 앰비언트는 약간 낮춤).
    scene.add(new THREE.AmbientLight(0xffffff, 0.42));
    const key = new THREE.DirectionalLight(0xffffff, 1.2); key.position.set(-260, -420, 700); scene.add(key);   // 키 라이트(좌상단-앞)
    const warm = new THREE.PointLight(0xffb877, 0.8, 3000); warm.position.set(220, -160, 480); scene.add(warm); // 따뜻한 필
    const rim = new THREE.PointLight(0x74a8ff, 1.0, 3000); rim.position.set(-220, 260, 360); scene.add(rim);     // 차가운 림(반대편 → 가장자리 강조)
    // 환경맵(스튜디오 그라디언트) → 금속/금빛이 실제 금속처럼 반사되어 보이게 한다.
    try {
      const pmrem = new THREE.PMREMGenerator(renderer);
      const cv = document.createElement("canvas"); cv.width = 16; cv.height = 64; const cx = cv.getContext("2d");
      const grd = cx.createLinearGradient(0, 0, 0, 64);   // 밝은 스튜디오 그라디언트 → 금속이 밝게 반사되게
      grd.addColorStop(0, "#f0f4fb"); grd.addColorStop(0.5, "#8b96a8"); grd.addColorStop(1, "#2c3444");
      cx.fillStyle = grd; cx.fillRect(0, 0, 16, 64);
      const tex = new THREE.CanvasTexture(cv); tex.mapping = THREE.EquirectangularReflectionMapping;
      scene.environment = pmrem.fromEquirectangular(tex).texture;
      tex.dispose(); pmrem.dispose();
    } catch (e) { /* PMREM 미지원이면 반사 없이 진행 */ }

    for (let i = 0; i < 5; i++) geos.push(makeRockGeo(i + 1));
    supported = true;
  } catch (e) {
    console.warn("[shatter3d] WebGL 사용 불가 — 파편 효과 비활성:", e);
    supported = false;
  }
  return supported;
}

function getChunk() {
  for (const c of pool) if (!c.active) return c;
  if (pool.length >= MAX_CHUNKS) return null;
  const geo = geos[(Math.random() * geos.length) | 0];
  const mat = new THREE.MeshStandardMaterial({ flatShading: true, roughness: 0.95, metalness: 0.0, transparent: true });
  const mesh = new THREE.Mesh(geo, mat);
  mesh.visible = false;
  scene.add(mesh);
  const c = { mesh, mat, vx: 0, vy: 0, vz: 0, ax: 0, ay: 0, az: 0, ttl: 0, life: 1, active: false };
  pool.push(c);
  return c;
}

// #c 의 화면 사각형에 오버레이를 정확히 겹치고, 렌더러/캔버스 크기를 맞춘다(레이아웃 변할 때만).
function syncRect() {
  const r = gameCanvas.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return;
  if (Math.abs(r.left - lastRect.l) < 0.5 && Math.abs(r.top - lastRect.t) < 0.5 &&
      Math.abs(r.width - lastRect.w) < 0.5 && Math.abs(r.height - lastRect.h) < 0.5) return;
  lastRect = { l: r.left, t: r.top, w: r.width, h: r.height };
  overlay.style.left = r.left + "px"; overlay.style.top = r.top + "px";
  overlay.style.width = r.width + "px"; overlay.style.height = r.height + "px";
  renderer.setSize(r.width, r.height, false);   // 스타일은 위에서 직접 지정하므로 updateStyle=false
}

// sx,sy: 512x768 화면좌표(카메라 반영됨). n: 부순 셀 수(규모). cellPx: 화면상 셀 크기(줌 반영, 파편 크기 기준).
export function spawnShatter(sx, sy, n, kind, cellPx) {
  if (!initOnce()) return;
  overlay.style.display = "block";
  const px = cellPx > 0 ? cellPx : 3.2;
  const count = Math.max(4, Math.min(18, Math.round(4 + n * 0.42)));
  const spread = Math.min(3.2, 1 + Math.sqrt(Math.max(1, n)) * 0.12);   // 규모가 클수록 넓게 튄다
  for (let i = 0; i < count; i++) {
    const c = getChunk(); if (!c) break;
    // 큰 파편 소수 + 작은 파편 다수 → 바위가 부서진 느낌
    const big = i < Math.max(1, count * 0.28);
    const scl = px * (big ? (1.1 + Math.random() * 0.9) : (0.5 + Math.random() * 0.7));
    c.mesh.scale.setScalar(Math.max(2, scl));
    c.mesh.position.set(sx + (Math.random() - 0.5) * px * 2, sy + (Math.random() - 0.5) * px * 2, (Math.random() - 0.5) * 40);
    c.mesh.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
    const ang = Math.random() * 6.2830, sp = (80 + Math.random() * 260) * spread;
    c.vx = Math.cos(ang) * sp;
    c.vy = -Math.abs(Math.sin(ang) * sp) - (120 + Math.random() * 260);   // 위로 튄 뒤 중력으로 낙하
    c.vz = (Math.random() - 0.5) * 120;
    c.ax = (Math.random() - 0.5) * 18; c.ay = (Math.random() - 0.5) * 18; c.az = (Math.random() - 0.5) * 18;
    c.life = 0.72 + Math.random() * 0.5; c.ttl = c.life;
    c.mat.color.setHex(ROCK_COLORS[(Math.random() * ROCK_COLORS.length) | 0]);
    c.mat.emissive.setHex(0x000000);   // 돌은 발광 없음(파편이 재사용되므로 매번 리셋)
    c.mat.opacity = 1;
    c.mesh.visible = true; c.active = true;
  }
}

// 플레이어 사망 연출: 마커가 자기 색으로 빛나는 파편이 되어 사방(위 포함)으로 터진다.
// colorCss: 플레이어 색(#rrggbb 등). cellPx: 화면상 마커 크기.
export function spawnDeathShards(sx, sy, colorCss, cellPx) {
  if (!initOnce()) return;
  overlay.style.display = "block";
  const col = new THREE.Color(colorCss || "#ffffff");
  const px = cellPx > 0 ? cellPx : 6;
  const count = 22;
  for (let i = 0; i < count; i++) {
    const c = getChunk(); if (!c) break;
    const scl = px * (0.4 + Math.random() * 0.9);
    c.mesh.scale.setScalar(Math.max(2, scl));
    c.mesh.position.set(sx + (Math.random() - 0.5) * px, sy + (Math.random() - 0.5) * px, (Math.random() - 0.5) * 30);
    c.mesh.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
    const ang = Math.random() * 6.283, sp = 220 + Math.random() * 380;   // 사방으로 강하게
    c.vx = Math.cos(ang) * sp;
    c.vy = Math.sin(ang) * sp - (60 + Math.random() * 200);              // 살짝 위로 편향
    c.vz = (Math.random() - 0.5) * 160;
    c.ax = (Math.random() - 0.5) * 26; c.ay = (Math.random() - 0.5) * 26; c.az = (Math.random() - 0.5) * 26;
    c.life = 0.55 + Math.random() * 0.4; c.ttl = c.life;
    c.mat.color.set(col); c.mat.emissive.set(col); c.mat.emissiveIntensity = 0.85;   // 플레이어 색으로 발광
    c.mat.opacity = 1;
    c.mesh.visible = true; c.active = true;
  }
}

// 맵 점유(밝힘) 연출: 점유된 영역 전체에 걸쳐 "검은 돌 껍질"이 벗겨지듯 위로 터진다.
// sx,sy: 점유 영역 중심(화면좌표). n: 점유 셀 수(영역 크기·흩뿌림 반경). cellPx: 화면상 셀 크기.
export function spawnReveal(sx, sy, n, cellPx) {
  if (!initOnce()) return;
  overlay.style.display = "block";
  const px = cellPx > 0 ? cellPx : 3.2;
  const count = Math.max(6, Math.min(26, Math.round(6 + n * 0.22)));
  const spread = Math.min(150, Math.sqrt(Math.max(1, n)) * px * 0.55);   // 점유 영역 크기만큼 흩뿌림
  for (let i = 0; i < count; i++) {
    const c = getChunk(); if (!c) break;
    const scl = px * (0.5 + Math.random() * 1.0);
    c.mesh.scale.setScalar(Math.max(2, scl));
    c.mesh.position.set(sx + (Math.random() - 0.5) * 2 * spread, sy + (Math.random() - 0.5) * 2 * spread, (Math.random() - 0.5) * 40);
    c.mesh.rotation.set(Math.random() * 6.28, Math.random() * 6.28, Math.random() * 6.28);
    const ang = Math.random() * 6.283, sp = 60 + Math.random() * 160;
    c.vx = Math.cos(ang) * sp;
    c.vy = -Math.abs(Math.sin(ang) * sp) - (140 + Math.random() * 220);   // 대체로 위로 튄다(껍질이 벗겨지듯)
    c.vz = (Math.random() - 0.5) * 100;
    c.ax = (Math.random() - 0.5) * 20; c.ay = (Math.random() - 0.5) * 20; c.az = (Math.random() - 0.5) * 20;
    c.life = 0.5 + Math.random() * 0.45; c.ttl = c.life;
    c.mat.color.setHex(DARK_COLORS[(Math.random() * DARK_COLORS.length) | 0]);
    c.mat.emissive.setHex(0x000000);
    c.mat.opacity = 1;
    c.mesh.visible = true; c.active = true;
  }
}

// 라인(에너지 필라멘트) 헬퍼 — 얇지만 밝게. LineSegments 는 점을 2개씩 짝지어 개별 선분.
function makeLine(pts, colorCss, opacity, segments) {
  const geo = new THREE.BufferGeometry().setFromPoints(pts);
  const mat = new THREE.LineBasicMaterial({ color: new THREE.Color(colorCss), transparent: true, opacity: opacity ?? 0.8 });
  return segments ? new THREE.LineSegments(geo, mat) : new THREE.Line(geo, mat);
}
const V = (x, y, z) => new THREE.Vector3(x, y, z || 0);
// 지오메트리 모서리를 밝은 선으로 덧그려 입체감/경계를 또렷하게(면 각도 threshold° 이상 경계만).
function addEdges(mesh, edgeColor, thresh, opacity) {
  const eg = new THREE.EdgesGeometry(mesh.geometry, thresh == null ? 16 : thresh);
  const m = new THREE.LineBasicMaterial({ color: edgeColor, transparent: true, opacity: opacity == null ? 0.85 : opacity });
  mesh.add(new THREE.LineSegments(eg, m));
  return m;
}

// 매개곡선(t:0..1 → Vector3)을 따라 튜브 정점을 만든다(평행이동 프레임). 같은 T·R 로 두 곡선을 만들면
// 정점 순서가 같아 모프 타깃(꼬임↔풀림)으로 쓸 수 있다. flatShading 이면 셰이더가 노멀을 매 프레임 계산.
function tubePositions(curve, tubeR, T, R) {
  const pos = new Float32Array((T + 1) * (R + 1) * 3);
  const pts = [], tans = [];
  for (let i = 0; i <= T; i++) { const t = i / T; pts.push(curve(t)); tans.push(curve((t + 1e-4) % 1.0000001).sub(curve(t)).normalize()); }
  let normal = new THREE.Vector3(1, 0, 0);
  if (Math.abs(tans[0].dot(normal)) > 0.9) normal.set(0, 1, 0);
  normal.crossVectors(tans[0], normal).cross(tans[0]).normalize();
  let idx = 0;
  for (let i = 0; i <= T; i++) {
    if (i > 0) {
      const axis = new THREE.Vector3().crossVectors(tans[i - 1], tans[i]); const l = axis.length();
      if (l > 1e-6) { axis.multiplyScalar(1 / l); normal.applyAxisAngle(axis, Math.atan2(l, tans[i - 1].dot(tans[i]))); }
    }
    const binormal = new THREE.Vector3().crossVectors(tans[i], normal).normalize();
    const n2 = new THREE.Vector3().crossVectors(binormal, tans[i]).normalize();
    for (let j = 0; j <= R; j++) {
      const a = j / R * Math.PI * 2, cx = Math.cos(a), sy = Math.sin(a);
      pos[idx++] = pts[i].x + tubeR * (cx * n2.x + sy * binormal.x);
      pos[idx++] = pts[i].y + tubeR * (cx * n2.y + sy * binormal.y);
      pos[idx++] = pts[i].z + tubeR * (cx * n2.z + sy * binormal.z);
    }
  }
  return pos;
}
function tubeIndexUV(T, R) {
  const index = [], uv = new Float32Array((T + 1) * (R + 1) * 2);
  for (let i = 0; i <= T; i++) for (let j = 0; j <= R; j++) { const k = i * (R + 1) + j; uv[k * 2] = i / T * 4; uv[k * 2 + 1] = j / R; }
  for (let i = 0; i < T; i++) for (let j = 0; j < R; j++) {
    const a = i * (R + 1) + j, b = (i + 1) * (R + 1) + j, c = (i + 1) * (R + 1) + (j + 1), d = i * (R + 1) + (j + 1);
    index.push(a, b, d, b, c, d);
  }
  return { index, uv };
}
const knotCurve = (tt) => { const t = tt * Math.PI * 2, R = 0.46, r = 0.18, p = 2, q = 3, cq = Math.cos(q * t); return new THREE.Vector3((R + r * cq) * Math.cos(p * t), (R + r * cq) * Math.sin(p * t), r * Math.sin(q * t)); };
const looseCurve = (tt) => { const t = tt * Math.PI * 2, R = 0.62; return new THREE.Vector3(R * Math.cos(t), R * Math.sin(t), 0); };

// 린넨(천) 질감 텍스처 — 캔버스로 직조(가로·세로 실) 패턴 + 노이즈. 색맵 겸 범프맵으로 쓴다.
function fabricTex() {
  const cv = document.createElement("canvas"); cv.width = cv.height = 64; const c = cv.getContext("2d");
  c.fillStyle = "#efe4c6"; c.fillRect(0, 0, 64, 64);
  for (let i = 0; i < 64; i += 4) {
    c.fillStyle = (i / 4) % 2 ? "rgba(120,105,70,0.20)" : "rgba(255,255,255,0.16)";
    c.fillRect(i, 0, 2, 64); c.fillRect(0, i, 64, 2);
  }
  const im = c.getImageData(0, 0, 64, 64), d = im.data;
  for (let i = 0; i < d.length; i += 4) { const n = (Math.random() - 0.5) * 26; d[i] += n; d[i + 1] += n; d[i + 2] += n; }
  c.putImageData(im, 0, 0);
  const t = new THREE.CanvasTexture(cv); t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(4, 2); return t;
}

// ── 3D 보스: 종류별로 실루엣 + 움직임 + "재질(텍스처)"이 모두 다르다 ──
// boss_ring=회색 금속 기어, boss_spiral=린넨(천) 매듭, boss_spread=다크 크롬 화살촉, boss_cross=금빛 십자.
function makeBossGroup(kind, colorCss) {
  const g = new THREE.Group();
  const spinner = new THREE.Group();
  g.add(spinner);
  const up = new THREE.Vector3(0, 1, 0);
  const b = { group: g, spinner, kind, baseR: 1.2, lineMats: [], lineBase: [], teeth: [], enr: 0, aim: 0, t: Math.random() * 6, baseX: 0, baseY: 0, sizePx: 60, seenAt: 0 };
  // 종류별 사실적 재질 + 모서리선 색/농도
  let coreMat, edgeCol, edgeOp = 0.9;
  // metalness 를 0.6 안팎으로 낮춰 확산광(색)이 조명에 드러나게 하고, 하이라이트로 금속감을 준다(HDRI 없이도 밝게).
  if (kind === "boss_ring") {          // 자동차 기어 같은 회색 금속
    coreMat = new THREE.MeshStandardMaterial({ color: 0xbcc4ce, metalness: 0.55, roughness: 0.38, envMapIntensity: 1.2 });
    edgeCol = new THREE.Color(0xeef2f8);
  } else if (kind === "boss_spiral") { // 린넨(천) 질감
    const ft = fabricTex();
    // flatShading: 모핑(풀림↔꼬임) 중에도 셰이더가 면 노멀을 매 프레임 계산해 음영이 정확하게 따라온다.
    coreMat = new THREE.MeshStandardMaterial({ map: ft, bumpMap: ft, bumpScale: 0.06, color: 0xefe4c6, roughness: 0.97, metalness: 0.0, flatShading: true });
    edgeCol = new THREE.Color(0xd8c9a0); edgeOp = 0.22;
  } else if (kind === "boss_spread") { // 다크 크롬(무기/미사일)
    coreMat = new THREE.MeshStandardMaterial({ color: 0x6b7280, metalness: 0.6, roughness: 0.3, envMapIntensity: 1.3 });
    edgeCol = new THREE.Color(0xd0d8e2);
  } else {                             // boss_cross: 밝은 금빛
    coreMat = new THREE.MeshStandardMaterial({ color: 0xffcf3a, metalness: 0.6, roughness: 0.34, emissive: 0x4a3200, emissiveIntensity: 0.28, envMapIntensity: 1.2 });
    edgeCol = new THREE.Color(0xfff2c0);
  }
  b.coreMat = coreMat; b.baseEmissive = coreMat.emissive.getHex(); b.baseEmInt = coreMat.emissiveIntensity;
  const darkMat = new THREE.MeshStandardMaterial({ color: 0x1a1d24, metalness: 0.9, roughness: 0.4, envMapIntensity: 0.9 });

  if (kind === "boss_ring") {                 // 원(코어)만 빠르게 회전 + 톱니 개별 회전 + 가운데 = 염소 눈
    const ringCore = new THREE.Group(); spinner.add(ringCore); b.ringCore = ringCore;
    ringCore.add(new THREE.Mesh(new THREE.TorusGeometry(0.78, 0.22, 20, 44), coreMat));   // 회전하는 금속 원
    // 가운데 염소 눈(가로 사각 동공): 회전하지 않고 정면을 보며 깜빡인다. group 의 기울기(-0.52)를 상쇄해 정면.
    const eye = new THREE.Group(); eye.rotation.x = 0.52; spinner.add(eye); b.eye = eye;
    const ball = new THREE.Mesh(new THREE.CircleGeometry(0.4, 40), new THREE.MeshStandardMaterial({ color: 0xcdb06a, roughness: 0.5, metalness: 0.1, emissive: 0x4a3410, emissiveIntensity: 0.35 }));
    ball.position.z = 0.02; eye.add(ball);
    const iris = new THREE.Mesh(new THREE.RingGeometry(0.24, 0.4, 40), new THREE.MeshStandardMaterial({ color: 0x9c7b3a, roughness: 0.6, emissive: 0x2a1c06, emissiveIntensity: 0.25, side: THREE.DoubleSide }));
    iris.position.z = 0.03; eye.add(iris);
    const pupil = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.13, 0.05), new THREE.MeshStandardMaterial({ color: 0x0d0a06, roughness: 0.7 }));   // 가로 사각 동공(염소)
    pupil.position.z = 0.06; eye.add(pupil);
    const tooth = new THREE.ConeGeometry(0.27, 0.68, 4);
    for (let k = 0; k < 12; k++) {              // 톱니: 원 바깥으로 간격을 두고 배치(제자리 개별 회전)
      const a = k * Math.PI / 6, dir = V(Math.cos(a), Math.sin(a), 0);
      const m = new THREE.Mesh(tooth, coreMat);
      m.position.copy(dir.clone().multiplyScalar(1.6)); m.quaternion.setFromUnitVectors(up, dir);
      addEdges(m, edgeCol, 1, edgeOp); spinner.add(m); b.teeth.push(m);
    }
    b.baseR = 1.95;   // (가장 바깥 원 라인 제거 — 요청)
  } else if (kind === "boss_spiral") {        // 린넨 매듭 — "풀렸다 꼬였다" 모프(꼬인 매듭 ↔ 느슨한 고리)
    const T = 130, Rr = 12, tr = 0.16;
    const geo = new THREE.BufferGeometry();
    const iuv = tubeIndexUV(T, Rr);
    geo.setAttribute("position", new THREE.BufferAttribute(tubePositions(knotCurve, tr, T, Rr), 3));
    geo.setAttribute("uv", new THREE.BufferAttribute(iuv.uv, 2));
    geo.setIndex(iuv.index);
    geo.morphAttributes.position = [new THREE.BufferAttribute(tubePositions(looseCurve, tr, T, Rr), 3)];   // 0=꼬임, 1=풀림
    const knot = new THREE.Mesh(geo, coreMat); knot.morphTargetInfluences = [0];
    spinner.add(knot); b.knot = knot;
    b.baseR = 0.85;
  } else if (kind === "boss_spread") {        // 다크 크롬 화살촉 + 뒷날개. (사이트 라인·레티클 제거 — 요청)
    const head = new THREE.Mesh(new THREE.ConeGeometry(0.62, 1.7, 4), coreMat);
    head.rotation.z = -Math.PI / 2; head.position.x = 0.15; spinner.add(head); addEdges(head, edgeCol, 1, edgeOp);
    const finGeo = new THREE.BoxGeometry(0.55, 0.09, 0.75);
    for (const s of [1, -1]) { const f = new THREE.Mesh(finGeo, darkMat); f.position.set(-0.5, 0, 0); f.rotation.z = s * 0.5; spinner.add(f); addEdges(f, edgeCol, 1, 0.55); }
    b.baseR = 1.1;
  } else {                                    // boss_cross: 금빛 3D 플러스. (4방향 빔 라인 제거 — 요청)
    for (const geo of [new THREE.BoxGeometry(2.5, 0.5, 0.5), new THREE.BoxGeometry(0.5, 2.5, 0.5), new THREE.BoxGeometry(0.82, 0.82, 0.82)]) {
      const m = new THREE.Mesh(geo, coreMat); spinner.add(m); addEdges(m, edgeCol, 1, edgeOp);
    }
    b.baseR = 1.4;
  }
  // 고정 3/4 뷰 기울기 → 정면 평면 실루엣이 아니라 부피가 보이는 입체로. (위치는 그대로, 보이는 각도만 기울임)
  if (kind === "boss_ring") g.rotation.x = -0.52;
  else if (kind === "boss_cross") g.rotation.set(-0.42, 0.4, 0);
  else if (kind === "boss_spread") g.rotation.x = -0.24;
  else g.rotation.x = -0.32;   // boss_spiral
  return b;
}

// 보스 정리(컬링/게임 종료 시): 그룹의 지오메트리·재질·텍스처를 해제해 메모리 누수를 막는다.
function disposeBoss(b) {
  b.group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) { if (o.material.map) o.material.map.dispose(); o.material.dispose(); }
  });
}

// 매 프레임 보스마다 호출: 화면좌표·크기·격노(0/1/2)·색·종류(kind)·조준(aim)을 반영. 3D 미지원이면 false.
export function updateBoss3D(id, sx, sy, sizePx, enr, colorCss, kind, aim) {
  if (!initOnce()) return false;
  overlay.style.display = "block";
  let b = bosses.get(id);
  if (!b) { b = makeBossGroup(kind, colorCss); scene.add(b.group); bosses.set(id, b); }
  b.baseX = sx; b.baseY = sy; b.sizePx = Math.max(6, sizePx);   // 움직임 패턴은 renderShatter가 이 기준점에 오프셋을 얹는다
  b.group.position.set(sx, sy, 0);
  b.group.scale.setScalar(b.sizePx / b.baseR);
  b.seenAt = performance.now(); b.enr = enr | 0; b.aim = aim || 0;
  // 격노 시엔 재질이 붉게 달아오르고, 평상시엔 재질 고유의 발광값(금빛 등)으로 되돌린다.
  if (enr >= 1) { b.coreMat.emissive.setHex(0xff2a2a); b.coreMat.emissiveIntensity = enr >= 2 ? 0.85 : 0.5; }
  else { b.coreMat.emissive.setHex(b.baseEmissive); b.coreMat.emissiveIntensity = b.baseEmInt; }
  return true;
}

// 매 프레임 호출: 파편 물리(중력·회전·페이드) + 보스 회전 갱신 후 렌더. 활성 요소가 없으면 오버레이를 숨긴다.
export function renderShatter(dt) {
  if (!supported || !renderer) return;
  syncRect();
  let any = false;
  for (const c of pool) {
    if (!c.active) continue;
    any = true;
    c.ttl -= dt;
    if (c.ttl <= 0) { c.active = false; c.mesh.visible = false; continue; }
    c.vy += GRAV * dt;
    c.mesh.position.x += c.vx * dt;
    c.mesh.position.y += c.vy * dt;
    c.mesh.position.z += c.vz * dt;
    c.mesh.rotation.x += c.ax * dt; c.mesh.rotation.y += c.ay * dt; c.mesh.rotation.z += c.az * dt;
    const k = c.ttl / c.life;                 // 1→0
    if (k < 0.4) { c.mat.opacity = Math.max(0, k / 0.4); c.mesh.scale.multiplyScalar(0.985); }
  }
  // 보스: 사라진 보스는 정리. 살아있는 보스는 종류별로 다른 "움직임 패턴"으로 갱신(단순 회전 탈피).
  const nowB = performance.now();
  for (const [id, b] of bosses) {
    if (nowB - b.seenAt > 220) { scene.remove(b.group); disposeBoss(b); bosses.delete(id); continue; }
    b.t += dt;
    const fast = b.enr >= 1 ? 1.6 : 0, sz = b.sizePx, sp = b.spinner;
    let ox = 0, oy = 0;
    if (b.kind === "boss_ring") {                 // 원(코어)만 빠르게 회전 + 톱니 개별 회전 + 충전 맥동 + 염소 눈 깜빡임
      if (b.ringCore) b.ringCore.rotation.z += dt * (2.8 + fast * 1.6);   // 원만 빠르게 회전
      for (const tt of b.teeth) tt.rotateY(dt * (5 + fast * 3));          // 톱니는 궤도 없이 자기 축으로 회전
      sp.scale.setScalar(1 + 0.08 * Math.sin(b.t * 3.2));                 // 충전 맥동
      if (b.eye) { const bp = b.t % (fast ? 1.8 : 3.2); b.eye.scale.y = bp < 0.18 ? Math.max(0.07, 1 - Math.sin(bp / 0.18 * Math.PI) * 0.93) : 1; }   // 깜빡임(격노 시 자주)
    } else if (b.kind === "boss_spiral") {        // 매듭: 작은 궤도 선회 + 뒤집힘 + "풀렸다 꼬였다" 모핑
      sp.rotation.z += dt * (1.2 + fast); sp.rotation.x = Math.sin(b.t * 0.8) * 0.5;
      ox = Math.cos(b.t * 1.7) * sz * 0.22; oy = Math.sin(b.t * 1.7) * sz * 0.22;
      if (b.knot && b.knot.morphTargetInfluences) b.knot.morphTargetInfluences[0] = 0.5 - 0.5 * Math.cos(b.t * (0.7 + fast * 0.5));   // 0(꼬임)↔1(풀림)
    } else if (b.kind === "boss_spread") {        // 조준 방향을 향해 주기적으로 확 돌진(런지)
      sp.rotation.z = b.aim; sp.rotation.x = Math.sin(b.t * 7) * 0.12;
      const lunge = Math.max(0, Math.sin(b.t * 2.2));
      ox = Math.cos(b.aim) * lunge * sz * 0.55; oy = Math.sin(b.aim) * lunge * sz * 0.55;
    } else {                                      // boss_cross: 90°씩 끊어 도는 계단 회전 + 팔 맥동
      const phase = b.t * (0.9 + fast), seg = Math.floor(phase), frac = phase - seg;
      const e = frac < 0.45 ? frac / 0.45 : 1, es = e * e * (3 - 2 * e);   // 앞 45%에 회전, 뒤 대기(기계적)
      sp.rotation.z = (seg + es) * (Math.PI / 2);
      const ap = 1 + 0.14 * Math.sin(b.t * 4); sp.scale.set(ap, ap, 1);
    }
    b.group.position.set(b.baseX + ox, b.baseY + oy, 0);
  }
  if (bosses.size) any = true;
  if (!any) { overlay.style.display = "none"; return; }
  renderer.render(scene, camera);
}

// 게임을 떠날 때 등: 모든 파편·보스를 즉시 정리하고 오버레이를 숨긴다.
export function clearShatter() {
  for (const c of pool) { c.active = false; if (c.mesh) c.mesh.visible = false; }
  for (const [, b] of bosses) { scene.remove(b.group); disposeBoss(b); }
  bosses.clear();
  if (overlay) overlay.style.display = "none";
}
