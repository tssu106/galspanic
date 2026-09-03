# 집 Windows 노트북 + Cloudflare Tunnel 배포 가이드

구매처: **Namecheap** 도메인 / 서버: **집 Windows 노트북** / 연결: **Cloudflare Tunnel**

이 방식의 장점: 공인 IP·포트포워딩·방화벽 인바운드 설정이 **전부 불필요**(cloudflared가
아웃바운드 연결만 함, 동적 IP·CGNAT여도 OK). 무료 HTTPS 자동. Namecheap 도메인 그대로 사용.

> 아래 명령은 **서버로 쓸 Windows 노트북**에서 실행합니다(개발용 Mac이 아님).

---

## 1. Node 설치 + 게임 빌드/실행

1. **Node.js 20 LTS** 설치: https://nodejs.org (Windows Installer .msi). **Git** 설치: https://git-scm.com
2. PowerShell에서:

```powershell
git clone https://github.com/tssu106/galspanic.git
cd galspanic\server
npm ci
npm run build
```

3. 프로덕션 실행(테스트):

```powershell
$env:NODE_ENV="production"; node dist\index.js
```

> ⚠️ `npm run prod` 는 리눅스 문법이라 Windows에선 안 됨. 위처럼 `$env:NODE_ENV` 로 실행.

4. 브라우저 `http://localhost:2567/index.html` → 게임이 뜨면 성공.
   (`NODE_ENV=production` 이라 dev 버튼/스테이지 선택 자동 숨김.) 확인했으면 Ctrl+C.

---

## 2. 항상 켜져 있게 (서비스 + 절전 해제)

**절전 방지(필수)**: 설정 → 시스템 → 전원 → *전원 연결 시 절전: 안 함*,
노트북이면 *덮개 닫을 때: 아무 것도 안 함*. 절전 들어가면 서버 멈춤.

**Node 서버를 Windows 서비스로 (재부팅·크래시 자동 재시작)** — NSSM 사용:

```powershell
winget install nssm
nssm install galspanic
```

설치 창에서:
- **Path**: `C:\Program Files\nodejs\node.exe`
- **Arguments**: `dist\index.js`
- **Startup directory**: 클론한 실제 경로의 `...\galspanic\server`
- **Environment** 탭: `NODE_ENV=production`
- Install service → `nssm start galspanic`

---

## 3. Namecheap 도메인을 Cloudflare로 연결

Cloudflare Tunnel은 도메인이 Cloudflare에서 관리돼야 함(무료).

1. **Cloudflare 무료 가입** → *Add a site* → 구매 도메인 입력 → Free 플랜.
2. Cloudflare가 **네임서버 2개** 안내(예: `xxx.ns.cloudflare.com`).
3. **Namecheap** → Domain List → 도메인 **Manage** → *Nameservers* → **Custom DNS** →
   Cloudflare 네임서버 2개 입력 → 저장.
4. 전파 몇 분~수 시간. Cloudflare에 **Active** 뜨면 완료.

---

## 4. Cloudflare Tunnel 만들기 (노트북 → Cloudflare)

1. Cloudflare 대시보드 → **Zero Trust** → **Networks → Tunnels** → **Create a tunnel**
   → **Cloudflared** → 이름 지정.
2. 화면의 **Windows 설치 명령(토큰 포함)** 을 노트북 PowerShell(관리자)에 붙여넣기
   → cloudflared가 **서비스로 자동 등록**되어 부팅 시 실행.
   (또는 먼저 `winget install --id Cloudflare.cloudflared`)
3. **Public Hostname** 추가:
   - Subdomain: 비움(루트 도메인) 또는 `www`
   - Domain: 구매 도메인 선택
   - Type: **HTTP**, URL: **`localhost:2567`**
   - 저장 → Cloudflare가 DNS(CNAME) 자동 생성.

WebSocket은 Cloudflare 기본 지원 → 게임의 wss 연결 그대로 동작(추가 설정 없음).

---

## 5. 확인 & 광고

- `https://<구매도메인>` 접속 → 게임이 https로 뜨고 자동 wss 연결. dev 기능은 숨김.
- **AdSense**: 라이브 후 `client/index.html` 상단 `window.ADSENSE_CLIENT = ""` 에
  본인 `ca-pub-...` 입력 → 저장(정적 서빙이라 재빌드 불필요, 새로고침). 그 뒤 이 도메인으로
  AdSense 사이트 승인 신청. `window.AD_FROM_STAGE`(기본 2)로 광고 시작 스테이지 조정.
  ⚠️ 자기 사이트에서 자기 광고 클릭 금지(계정 정지 위험).

---

## 업데이트(재배포)

로컬(Mac)에서 커밋·푸시 후, Windows 노트북에서:

```powershell
cd galspanic; git pull; cd server; npm ci; npm run build; nssm restart galspanic
```

---

## 문제 해결 팁

- **도메인 접속이 안 됨**: Cloudflare가 Active인지, Tunnel이 "Healthy"인지, Public Hostname의
  URL이 `localhost:2567` 인지 확인.
- **게임은 뜨는데 연결 안 됨(status: connecting)**: Node 서버(서비스)가 실행 중인지
  `nssm status galspanic`, 로컬 `http://localhost:2567` 이 되는지 확인.
- **노트북 재부팅 후 멈춤**: NSSM 서비스와 cloudflared 서비스가 모두 자동 시작인지 확인,
  절전 설정이 "안 함"인지 재확인.
