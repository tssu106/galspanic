// server/.env 를 읽어 process.env 에 넣는다(의존성 없이). 없으면 조용히 통과.
// 비밀키(SUPABASE_SERVICE_ROLE 등)를 커밋 없이 주입하는 용도. index.ts 최상단에서 import.
import fs from "fs";
import path from "path";

try {
  const envPath = path.join(__dirname, "..", ".env");   // server/.env
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (m && process.env[m[1]] === undefined) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");   // 양끝 따옴표 제거
      }
    }
  }
} catch { /* .env 없거나 읽기 실패 → 무시 */ }
