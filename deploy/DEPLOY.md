# Oracle Cloud (Always Free) 배포 가이드

이 게임은 **상시 실행 Node + Colyseus(WebSocket) 서버**입니다. 서버 하나가 클라이언트 HTML·이미지·게임로직·방(로비)까지 전부 서빙하므로 **VM 한 대로 끝**납니다.

> Claude가 미리 해둔 것: 프로덕션 빌드(`npm run build` = sim 번들 + tsc), 실행 위치와 무관한 정적 경로, `NODE_ENV=production` 시 dev 기능 자동 숨김, systemd/Caddy 파일. 아래는 **오라클 계정·SSH가 필요한 부분**을 직접 하시면 됩니다.

---

## 1. 오라클 VM 만들기

1. cloud.oracle.com 가입(카드 인증 필요, Always Free는 과금 안 됨).
2. **Compute → Instances → Create Instance**
   - 이미지: **Canonical Ubuntu 22.04**
   - Shape:
     - **Ampere A1 (ARM)** — Always Free 최대 4 OCPU/24GB (품절 잦음, 이 게임엔 1 OCPU/6GB면 충분)
     - 품절이면 **VM.Standard.E2.1.Micro (AMD, 1GB)** — 이 게임엔 그래도 충분
   - **SSH 키**: 로컬의 공개키를 붙여넣기 (없으면 `ssh-keygen`으로 생성)
3. 생성 후 **Public IP** 메모.

## 2. 포트 열기 (⚠️ 오라클 최대 함정 — 두 군데 다 해야 함)

**(a) OCI 방화벽 (Security List / NSG)**
- Instance → 서브넷 → Security List → **Add Ingress Rules**
- Caddy(HTTPS) 쓰면: TCP **443**(+ 인증서용 **80**) 개방 (Source `0.0.0.0/0`)
- Cloudflare Tunnel 쓰면(3-B): **포트 개방 불필요** (아웃바운드만 사용)

**(b) VM 내부 방화벽 (iptables)** — Ubuntu 오라클 이미지는 기본으로 막혀 있음
```bash
sudo iptables -I INPUT -p tcp --dport 443 -j ACCEPT
sudo iptables -I INPUT -p tcp --dport 80  -j ACCEPT
sudo netfilter-persistent save   # 재부팅 후에도 유지
```

## 3. Node·코드 설치 & 빌드

SSH 접속: `ssh ubuntu@<PUBLIC_IP>`
```bash
# Node 20 (nodesource)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git

# 코드
git clone https://github.com/tssu106/galspanic.git
cd galspanic/server
npm ci
npm run build          # sim 번들 + tsc → dist

# 동작 확인 (포트 2567)
NODE_ENV=production node dist/index.js
#  → "listening on ... 2567" 나오면 Ctrl+C
```

## 4. 서비스로 상시 실행 (systemd)

```bash
which node                                   # 보통 /usr/bin/node — 아니면 서비스 파일 ExecStart 수정
sudo cp ~/galspanic/deploy/galspanic.service /etc/systemd/system/
# (User/WorkingDirectory/노드 경로가 환경과 맞는지 확인 후)
sudo systemctl daemon-reload
sudo systemctl enable --now galspanic
sudo systemctl status galspanic --no-pager   # active (running) 확인
```

## 5. HTTPS 붙이기 (브라우저가 https면 자동으로 wss 접속하므로 필수)

### 방법 A. 도메인 + Caddy (도메인 있으면 가장 깔끔)
1. 도메인 DNS **A레코드 → VM Public IP**.
2. Caddy 설치 + 설정:
```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy

# deploy/Caddyfile 의 your-domain.example.com 을 실제 도메인으로 바꾼 뒤
sudo cp ~/galspanic/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl restart caddy
```
→ `https://your-domain` 접속 = 게임. 인증서는 Caddy가 자동 발급/갱신.

### 방법 B. Cloudflare Tunnel (도메인 구매·포트 개방 없이 가장 쉬움)
- Cloudflare 계정(무료) → Zero Trust → **Tunnels → Create** → `cloudflared` 설치 안내대로.
- 터널이 로컬 `localhost:2567` 을 감싸 **자동 HTTPS 주소**를 줍니다. OCI/iptables 포트 개방 불필요(아웃바운드만).
```bash
# 예시 (대시보드의 커넥터 설치 명령을 그대로 사용)
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o cloudflared
sudo install cloudflared /usr/local/bin/
# 이후 대시보드에서 발급한 토큰으로 서비스 등록 → localhost:2567 매핑
```

## 6. 업데이트(재배포)

로컬에서 커밋·푸시 후, VM에서:
```bash
cd ~/galspanic && bash deploy/deploy.sh
```
(git pull → npm ci → build → systemctl restart)

---

### 요약
- 서버: `NODE_ENV=production node dist/index.js` (포트 2567), systemd로 상시 실행
- HTTPS: 도메인이면 **Caddy**, 아니면 **Cloudflare Tunnel**
- 접속: 발급된 **https 주소**로 들어가면 클라이언트가 자동으로 **wss** 연결
- 프로덕션에선 dev 버튼/스테이지 선택이 자동으로 숨겨집니다(`/config` → `dev:false`)
