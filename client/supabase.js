// Supabase 연동: 로그인/인증 + 도감(collections) DB.
// anon(publishable) 키는 클라이언트 공개용이라 코드에 있어도 안전하다 — 실제 접근은 RLS 가 막는다.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://qtrcoicleczgdtbtnvyu.supabase.co";
const SUPABASE_ANON =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF0cmNvaWNsZWN6Z2R0YnRudnl1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODc5OTY5NDgsImV4cCI6MjEwMzU3Mjk0OH0.usPYHuMgWhvAZwkpO3zcNkXhze8DgLHGRheuw-YA8n4";

export const supa = createClient(SUPABASE_URL, SUPABASE_ANON, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
});

// ── 인증 ──────────────────────────────────────────────
export async function getUser() {
  const { data } = await supa.auth.getUser();
  return data && data.user ? data.user : null;
}
export function onAuth(cb) {
  // 구독 즉시 현재 세션으로 한 번 호출되고, 이후 로그인/로그아웃마다 호출된다.
  supa.auth.onAuthStateChange((_ev, session) => cb(session && session.user ? session.user : null));
}
export async function signIn(email, password) { return supa.auth.signInWithPassword({ email, password }); }
// 회원가입 시 플레이어 이름을 계정 메타데이터(user_metadata.name)에 저장 → 게임에서 사용.
export async function signUp(email, password, name) {
  return supa.auth.signUp({ email, password, options: { data: { name: (name || "").slice(0, 12) } } });
}
export async function signOut() { return supa.auth.signOut(); }
// 현재 세션의 access token (게임 서버로 전달해 서버가 검증·도감 기록). 로그아웃이면 null.
export async function getToken() {
  const { data } = await supa.auth.getSession();
  return data && data.session ? data.session.access_token : null;
}

// ── 도감(collections): 클라이언트는 읽기만 (쓰기는 서버 권위) ──
export async function dbGetCollection() {
  const { data, error } = await supa.from("collections").select("image_id");
  if (error) { console.warn("도감 로드 실패:", error.message); return []; }
  return (data || []).map((r) => r.image_id);
}

// ── 계정 최고기록(records): 본인 행만 읽기 (쓰기는 서버 권위) ──
export async function dbGetRecord() {
  const { data, error } = await supa.from("records").select("best_score,best_time_ms,best_stage").maybeSingle();
  if (error) { console.warn("최고기록 로드 실패:", error.message); return null; }
  return data || null;
}

// ── 데일리 랭킹(daily_scores): 공개 읽기(그날 전체) ──
export async function dbDailyTop(day, limit = 50) {
  const { data, error } = await supa
    .from("daily_scores").select("user_id,name,score,stage,time_ms")
    .eq("day", day).order("score", { ascending: false }).limit(limit);
  if (error) { console.warn("랭킹 로드 실패:", error.message); return []; }
  return data || [];
}
