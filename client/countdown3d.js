// 게임 오버 카운트다운을 three.js 로 3D 렌더한다. 숫자 "자체"를 입체(압출)로 만들어 회전시킨다
// (판/슬라브가 아니라 진짜 3D 숫자). WebGL 을 못 쓰면 supported=false → 호출부가 2D 폴백을 쓴다.
import * as THREE from "./vendor/three.module.min.js";
import { FontLoader } from "./vendor/addons/FontLoader.js";
import { TextGeometry } from "./vendor/addons/TextGeometry.js";

let renderer, scene, camera, ring, ring2, textMesh, font, textMat;
let inited = false, supported = false, active = false, lastNum = -1, popT = 0, pendingNum = -1;

function initOnce() {
  if (inited) return supported;
  inited = true;
  try {
    const canvas = document.getElementById("fx3d");
    renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setClearColor(0x000000, 0);   // 투명 배경 — 숫자·링 외에는 뒤 게임 화면이 그대로 보이게
    scene = new THREE.Scene();
    camera = new THREE.PerspectiveCamera(45, 1, 0.1, 100);
    camera.position.set(0, 0, 18);         // 뒤로 물려 숫자·링을 현재의 절반 크기로

    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const p1 = new THREE.PointLight(0xff5db1, 3.2, 80); p1.position.set(5, 6, 8); scene.add(p1);
    const p2 = new THREE.PointLight(0x22d3ee, 2.8, 80); p2.position.set(-6, -4, 7); scene.add(p2);
    const d1 = new THREE.DirectionalLight(0xffffff, 0.9); d1.position.set(0, 3, 6); scene.add(d1);

    // 발광하는 금속 느낌의 3D 숫자 재질
    textMat = new THREE.MeshStandardMaterial({ color: 0xffe9a8, emissive: 0xff2a7a,
      emissiveIntensity: 0.35, metalness: 0.6, roughness: 0.25 });

    ring = new THREE.Mesh(new THREE.TorusGeometry(2.4, 0.045, 16, 96), new THREE.MeshBasicMaterial({ color: 0xffd54a }));
    ring.position.z = -0.4; scene.add(ring);
    ring2 = new THREE.Mesh(new THREE.TorusGeometry(2.8, 0.028, 12, 96), new THREE.MeshBasicMaterial({ color: 0x22d3ee }));
    ring2.position.z = -0.5; scene.add(ring2);

    // 폰트는 비동기 로드. 도착하면 대기 중이던 숫자를 만든다. (로컬 vendored → 빠름)
    new FontLoader().load("./vendor/fonts/helvetiker_bold.typeface.json",
      (f) => { font = f; if (pendingNum >= 0) buildText(pendingNum); },
      undefined,
      (err) => console.warn("[countdown3d] 폰트 로드 실패:", err));

    resize();
    window.addEventListener("resize", resize);
    supported = true;
  } catch (e) {
    console.warn("[countdown3d] WebGL 사용 불가 — 2D 폴백:", e);
    supported = false;
  }
  return supported;
}

function resize() {
  if (!renderer) return;
  const w = window.innerWidth, h = window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.updateProjectionMatrix();
}

function buildText(n) {
  pendingNum = n;
  if (!font) return;                       // 폰트 도착 후 pendingNum 으로 다시 호출됨
  if (textMesh) { scene.remove(textMesh); textMesh.geometry.dispose(); textMesh = null; }
  const geo = new TextGeometry(String(n), {
    font, size: 2.6, height: 0.7, curveSegments: 8,          // height = 압출 깊이(입체감)
    bevelEnabled: true, bevelThickness: 0.09, bevelSize: 0.07, bevelSegments: 3,
  });
  geo.center();                             // 숫자를 원점 중앙에 맞춰 가운데를 축으로 회전
  textMesh = new THREE.Mesh(geo, textMat);
  scene.add(textMesh);
}

export function isSupported() { return initOnce(); }

export function showCountdown3D() {
  const ok = initOnce();
  active = true; lastNum = -1; popT = 0;
  const cv = document.getElementById("fx3d");
  if (cv) cv.style.display = ok ? "" : "none";
  return ok;
}

export function hideCountdown3D() {
  active = false;
  const cv = document.getElementById("fx3d"); if (cv) cv.style.display = "none";
}

// remaining: 남은 초(실수), now: performance.now(), dt: 프레임 간격(초)
export function renderCountdown3D(remaining, now, dt) {
  if (!active || !supported || !renderer) return;
  const n = Math.max(0, Math.ceil(remaining));
  if (n !== lastNum) { lastNum = n; buildText(n); popT = 0.45; }   // 숫자 바뀔 때 팝
  popT = Math.max(0, popT - dt);
  const pop = 1 + popT * popT * 2.2;                                // 급하게 커졌다 안정화
  if (textMesh) {
    textMesh.rotation.y = Math.sin(now / 560) * 0.95;              // 좌우로 스윙하며 입체 옆면이 보이게
    textMesh.rotation.x = Math.sin(now / 950) * 0.12;
    textMesh.scale.setScalar(pop);
  }
  ring.rotation.z = now / 900;
  ring2.rotation.z = -now / 1400;
  renderer.render(scene, camera);
}
