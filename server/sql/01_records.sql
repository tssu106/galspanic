-- ─────────────────────────────────────────────────────────────────────────
-- 계정 최고기록(records) : 점수/기록 저장 기능의 백엔드.
-- Supabase 대시보드 → SQL Editor 에 붙여넣고 Run.
--   · 서버(service_role)만 기록(RLS 우회), 각 사용자는 본인 행만 읽기.
--   · record_best() 가 지표를 max/min 병합(덮어쓰기·경합 방지). null 인자는 그 지표를 건너뜀.
-- ─────────────────────────────────────────────────────────────────────────

create table if not exists public.records (
  user_id      uuid primary key references auth.users(id) on delete cascade,
  best_score   int  not null default 0,
  best_time_ms int,                 -- 가장 빠른 스테이지 클리어 시간(ms). null = 아직 없음
  best_stage   int  not null default 0,
  updated_at   timestamptz not null default now()
);

alter table public.records enable row level security;

-- 본인 기록만 읽기 (쓰기는 service_role 이 RLS 를 우회한다)
drop policy if exists "read own record" on public.records;
create policy "read own record" on public.records
  for select using (auth.uid() = user_id);

-- 지표를 max/min 병합 upsert. null 인자는 해당 지표를 갱신하지 않는다.
create or replace function public.record_best(
  p_user uuid, p_time_ms int, p_stage int, p_score int
) returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.records (user_id, best_score, best_time_ms, best_stage, updated_at)
  values (p_user, coalesce(p_score, 0), p_time_ms, coalesce(p_stage, 0), now())
  on conflict (user_id) do update set
    best_score   = greatest(public.records.best_score, coalesce(p_score, 0)),
    best_time_ms = case
                     when p_time_ms is null then public.records.best_time_ms
                     when public.records.best_time_ms is null then p_time_ms
                     else least(public.records.best_time_ms, p_time_ms)
                   end,
    best_stage   = greatest(public.records.best_stage, coalesce(p_stage, 0)),
    updated_at   = now();
end;
$$;

grant execute on function public.record_best(uuid, int, int, int) to service_role;
