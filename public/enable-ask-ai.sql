-- Ask AI: each account may store its own Gemini API key, encrypted in the
-- browser with a passphrase only that person knows (AES-GCM, PBKDF2-SHA256).
-- The database never receives the key or the passphrase. Re-running is safe.
create table if not exists public.note_ai_keys (
  owner_id uuid primary key default auth.uid() references auth.users(id) on delete cascade,
  provider text not null default 'gemini' check (provider = 'gemini'),
  ciphertext text not null check (length(ciphertext) between 24 and 4096),
  iv text not null check (length(iv) between 12 and 64),
  salt text not null check (length(salt) between 16 and 64),
  iterations integer not null check (iterations between 100000 and 5000000),
  updated_at timestamptz not null default now()
);
alter table public.note_ai_keys enable row level security;
revoke all on public.note_ai_keys from anon;
grant select, insert, update, delete on public.note_ai_keys to authenticated;
drop policy if exists own_ai_key on public.note_ai_keys;
create policy own_ai_key on public.note_ai_keys for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
