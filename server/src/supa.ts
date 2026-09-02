// 서버 권위 도감: 클라이언트는 읽기만, unlock 기록은 서버가 service_role 로 한다(RLS 우회).
// service_role 키는 절대 커밋·클라 노출 금지 → 환경변수(SUPABASE_SERVICE_ROLE)로만 주입.
// env 는 함수 안에서 lazy 하게 읽어, 로드 순서와 무관하게 동작한다.
const url = () => process.env.SUPABASE_URL || "https://qtrcoicleczgdtbtnvyu.supabase.co";
const service = () => process.env.SUPABASE_SERVICE_ROLE || "";

export function supaReady(): boolean { return !!service(); }

// 클라이언트가 보낸 Supabase access token 을 검증해 user id 를 얻는다(위조 방지). 실패 시 null.
export async function verifyToken(token?: string): Promise<string | null> {
  const S = service();
  if (!token || !S) return null;
  try {
    const r = await fetch(`${url()}/auth/v1/user`, {
      headers: { apikey: S, Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    const u: any = await r.json();
    return u && typeof u.id === "string" ? u.id : null;
  } catch {
    return null;
  }
}

// 도감 unlock 기록 (service_role → RLS 우회 upsert). SERVICE 없으면 조용히 스킵.
export async function recordUnlock(userId: string, imageId: string): Promise<void> {
  const S = service();
  if (!S || !userId || !imageId) return;
  try {
    await fetch(`${url()}/rest/v1/collections`, {
      method: "POST",
      headers: {
        apikey: S,
        Authorization: `Bearer ${S}`,
        "Content-Type": "application/json",
        Prefer: "resolution=merge-duplicates",   // 이미 있으면 무시(중복 방지)
      },
      body: JSON.stringify({ user_id: userId, image_id: imageId }),
    });
  } catch (e) {
    console.warn("[supa] recordUnlock 실패:", (e as Error).message);
  }
}

// 계정 최고기록 갱신: DB 함수(record_best)가 각 지표를 max/min 병합한다(경합·덮어쓰기 방지).
// 지표는 있는 것만 보낸다(null 은 함수에서 무시). 테이블/함수(SQL) 미준비거나 SERVICE 없으면 조용히 스킵.
export async function recordBest(
  userId: string,
  rec: { timeMs?: number; stage?: number; score?: number },
): Promise<void> {
  const S = service();
  if (!S || !userId) return;
  try {
    await fetch(`${url()}/rest/v1/rpc/record_best`, {
      method: "POST",
      headers: {
        apikey: S,
        Authorization: `Bearer ${S}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        p_user: userId,
        p_time_ms: rec.timeMs ?? null,
        p_stage: rec.stage ?? null,
        p_score: rec.score ?? null,
      }),
    });
  } catch (e) {
    console.warn("[supa] recordBest 실패:", (e as Error).message);
  }
}
