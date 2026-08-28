#!/usr/bin/env bash
# VM에서 최신 코드로 갱신·재빌드·재시작하는 헬퍼. (최초 1회 설정은 deploy/DEPLOY.md 참고)
# 사용: repo 안에서  bash deploy/deploy.sh
set -euo pipefail

cd "$(dirname "$0")/.."          # repo 루트로 이동
echo "▶ git pull"
git pull --ff-only

cd server
echo "▶ npm ci (의존성 설치)"
npm ci
echo "▶ npm run build (sim 번들 + tsc → dist)"
npm run build

echo "▶ 서비스 재시작"
sudo systemctl restart galspanic

echo "✅ 배포 완료. 상태 확인:  sudo systemctl status galspanic --no-pager"
