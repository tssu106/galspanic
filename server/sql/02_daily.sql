-- ─────────────────────────────────────────────────────────────────────────
-- 데일리 챌린지 랭킹(daily_scores). Supabase → SQL Editor 에 붙여넣고 Run.
--   · 그날 같은 시드(보드)로 플레이한 점수를 사용자당 1행 저장(같은 날 최고점만 반영).
--   · 리더보드는 공개 읽기(그날 모든 점수), 쓰기는 서버(service_role)만.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.daily_scores (
  day        date not null,                         -- KST 기준 날짜
  user_id    uuid not null references auth.users(id) on delete cascade,
  name       text not null default '',
  score      int  not null default 0,
  stage      int  not null default 0,
  time_ms    int,
  updated_at timestamptz not null default now(),
  primary key (day, user_id)
);

alter table public.daily_scores enable row level security;

-- 리더보드: 누구나 읽기(그날의 모든 점수). 쓰기는 service_role 이 RLS 를 우회한다.
drop policy if exists "read daily" on public.daily_scores;
create policy "read daily" on public.daily_scores for select using (true);

-- 같은 날 더 높은 점수만 반영(이름·시간은 그 최고 기록의 것으로, 스테이지는 최대치).
create or replace function public.submit_daily(
  p_user uuid, p_name text, p_day date, p_score int, p_stage int, p_time_ms int
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.daily_scores (day, user_id, name, score, stage, time_ms, updated_at)
  values (p_day, p_user, coalesce(p_name, ''), coalesce(p_score, 0), coalesce(p_stage, 0), p_time_ms, now())
  on conflict (day, user_id) do update set
    name    = case when excluded.score > public.daily_scores.score then excluded.name    else public.daily_scores.name    end,
    time_ms = case when excluded.score > public.daily_scores.score then excluded.time_ms else public.daily_scores.time_ms end,
    stage   = greatest(public.daily_scores.stage, excluded.stage),
    score   = greatest(public.daily_scores.score, excluded.score),
    updated_at = now();
end;
$$;

grant execute on function public.submit_daily(uuid, text, date, int, int, int) to service_role;
