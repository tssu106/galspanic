// 데일리 챌린지: 한국시간(KST) 기준 날짜로 키/시드를 만든다 → 그날은 모두 같은 보드를 받는다.
// (gameSeed 가 라운드 보드를 완전히 결정하므로, 같은 시드면 적 배치·안전지대까지 동일)

// "YYYY-MM-DD" (KST). 하루 경계는 한국시간 자정.
export function dailyKey(now: Date = new Date()): string {
  const kst = new Date(now.getTime() + 9 * 3600 * 1000); // UTC+9
  return kst.toISOString().slice(0, 10);
}

// 날짜 문자열 → 32bit 시드 (FNV-1a). 같은 날이면 항상 같은 값.
export function dailySeed(key: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
