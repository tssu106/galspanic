// galspanic 서버 제어판. 의존성 없이 Node 내장 모듈만 사용.
// 실행: node launcher/launcher.js  (또는 start-launcher.bat 더블클릭)
// 브라우저에서 http://localhost:5050 → 시작/중지/재시작 버튼으로 게임 서버 제어.
const http = require("http");
const { spawn, exec } = require("child_process");
const path = require("path");

const CONTROL_PORT = 5050;
const GAME_PORT = 2567;
const REPO = path.join(__dirname, ".."); // 저장소 루트 (launcher 의 상위)

// 게임 서버가 떠 있는지 /health 로 확인
function gameHealth() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: GAME_PORT, path: "/health", timeout: 1500 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => { req.destroy(); resolve(false); });
  });
}

// 게임 서버 시작 (detached → 이 제어판을 닫아도 서버는 계속 실행)
function startGame() {
  const child = spawn("npm --prefix server start", {
    cwd: REPO, detached: true, stdio: "ignore", shell: true, windowsHide: true,
  });
  child.unref();
}

// 2567 포트를 잡고 있는 프로세스를 찾아 종료
function stopGame() {
  return new Promise((resolve) => {
    exec(`netstat -ano | findstr :${GAME_PORT} | findstr LISTENING`, (_e, out) => {
      const pids = new Set();
      String(out || "").split(/\r?\n/).forEach((line) => {
        const m = line.trim().match(/(\d+)\s*$/);
        if (m && m[1] !== "0") pids.add(m[1]);
      });
      if (!pids.size) return resolve(false);
      let done = 0;
      pids.forEach((pid) => exec(`taskkill /F /T /PID ${pid}`, () => { if (++done === pids.size) resolve(true); }));
    });
  });
}

const PAGE = `<!DOCTYPE html><html lang="ko"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>galspanic 서버 제어판</title>
<style>
  :root{--bg:#0e1018;--panel:#1a1e2e;--line:#2a3048;--ink:#e7eaf6;--muted:#9aa3bd;--ok:#37d39b;--bad:#ff5d6c;--accent:#7c5cff;}
  *{box-sizing:border-box} html,body{height:100%}
  body{margin:0;background:radial-gradient(1000px 700px at 50% -10%,#1c2138,var(--bg));color:var(--ink);
       font-family:system-ui,"Malgun Gothic",sans-serif;display:flex;align-items:center;justify-content:center;padding:20px}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:18px;padding:26px;max-width:420px;width:100%;
        box-shadow:0 20px 60px rgba(0,0,0,.5);text-align:center}
  h1{margin:0 0 4px;font-size:20px} h1 span{color:#ff5db1}
  .sub{color:var(--muted);font-size:13px;margin-bottom:20px}
  .status{display:flex;align-items:center;justify-content:center;gap:10px;font-size:18px;font-weight:800;
          padding:14px;border:1px solid var(--line);border-radius:12px;background:#0e1120;margin-bottom:18px}
  .dot{width:14px;height:14px;border-radius:50%;box-shadow:0 0 10px currentColor}
  .up .dot{background:var(--ok);color:var(--ok)} .down .dot{background:var(--bad);color:var(--bad)}
  .up{color:var(--ok)} .down{color:var(--bad)}
  .btns{display:grid;grid-template-columns:1fr 1fr;gap:10px}
  button{border:0;border-radius:10px;padding:13px;font-size:15px;font-weight:700;cursor:pointer;color:#fff}
  button:disabled{opacity:.5;cursor:default}
  .start{background:linear-gradient(90deg,#37d39b,#22b07f);grid-column:1/3}
  .stop{background:#3a4356} .restart{background:var(--accent)}
  .open{display:block;margin-top:14px;color:#ff5db1;text-decoration:none;font-weight:700;font-size:14px}
  .open.disabled{color:var(--muted);pointer-events:none}
  .log{margin-top:14px;color:var(--muted);font-size:12px;min-height:16px}
</style></head><body>
  <div class="card">
    <h1>🕹 galspanic <span>서버 제어판</span></h1>
    <div class="sub">게임 서버(포트 2567)를 켜고 끕니다</div>
    <div id="status" class="status down"><span class="dot"></span><span id="statusText">확인 중…</span></div>
    <div class="btns">
      <button class="start" id="btnStart">▶ 서버 시작</button>
      <button class="stop" id="btnStop">■ 중지</button>
      <button class="restart" id="btnRestart">↻ 재시작</button>
    </div>
    <a class="open disabled" id="openGame" href="http://localhost:${GAME_PORT}/index.html" target="_blank">게임 열기 →</a>
    <div class="log" id="log"></div>
  </div>
<script>
  const $=(id)=>document.getElementById(id);
  let busy=false;
  function setLog(t){ $("log").textContent=t; }
  function render(up){
    const s=$("status");
    s.className="status "+(up?"up":"down");
    $("statusText").textContent=up?"실행 중":"중지됨";
    $("btnStart").disabled=busy||up;
    $("btnStop").disabled=busy||!up;
    $("btnRestart").disabled=busy;
    $("openGame").classList.toggle("disabled",!up);
  }
  async function status(){ try{ const r=await fetch("/api/status"); const j=await r.json(); render(j.up); }catch(e){ render(false); } }
  async function call(path,label){
    if(busy)return; busy=true; setLog(label+"…"); render(false);
    try{ await fetch(path,{method:"POST"}); }catch(e){}
    // 시작/재시작은 뜨는 데 시간이 걸리므로 잠시 폴링
    for(let i=0;i<20;i++){ await new Promise(r=>setTimeout(r,800)); const r=await fetch("/api/status"); const j=await r.json();
      if((label.includes("중지"))? !j.up : j.up){ break; } }
    busy=false; setLog(""); status();
  }
  $("btnStart").onclick=()=>call("/api/start","서버 시작");
  $("btnStop").onclick=()=>call("/api/stop","중지");
  $("btnRestart").onclick=()=>call("/api/restart","재시작");
  status(); setInterval(()=>{ if(!busy) status(); },2000);
</script></body></html>`;

const server = http.createServer(async (req, res) => {
  if (req.url === "/" || req.url === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return res.end(PAGE);
  }
  if (req.url === "/api/status") {
    const up = await gameHealth();
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ up }));
  }
  if (req.method === "POST" && req.url === "/api/start") {
    if (!(await gameHealth())) startGame();
    res.writeHead(200); return res.end("ok");
  }
  if (req.method === "POST" && req.url === "/api/stop") {
    await stopGame();
    res.writeHead(200); return res.end("ok");
  }
  if (req.method === "POST" && req.url === "/api/restart") {
    await stopGame();
    setTimeout(startGame, 1200);
    res.writeHead(200); return res.end("ok");
  }
  res.writeHead(404); res.end("not found");
});

server.listen(CONTROL_PORT, () => {
  const url = `http://localhost:${CONTROL_PORT}`;
  console.log(`[galspanic 제어판] ${url} 에서 열렸습니다. 브라우저가 자동으로 열립니다.`);
  exec(`start "" ${url}`);   // 기본 브라우저로 제어판 열기
});
