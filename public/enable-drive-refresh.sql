-- Run in Supabase SQL Editor before deploying the drive-session Edge Function.
-- Safe to rerun. This table stores only server-encrypted credentials; the browser
-- has no permission to read or modify it, including its own account's row.
-- The encryption key and Google client secret belong in Edge Function secrets.
begin;
create table if not exists public.note_drive_credentials (
  owner_id uuid primary key references auth.users(id) on delete cascade,
  google_subject text not null check (length(google_subject) between 1 and 255),
  version uuid not null,
  encrypted_payload text not null check (length(encrypted_payload) between 1 and 65536),
  updated_at timestamptz not null default now()
);
alter table public.note_drive_credentials enable row level security;
revoke all on public.note_drive_credentials from public, anon, authenticated;
-- No user-facing RLS policy: only the trusted Edge Function service-role client
-- can access ciphertext. JWT validation and Google-account checks happen there.
-- Remove any policies left by a partial/manual setup on rerun as well.
do $$
declare item record;
begin
  for item in select policyname from pg_policies where schemaname = 'public' and tablename = 'note_drive_credentials' loop
    execute format('drop policy %I on public.note_drive_credentials', item.policyname);
  end loop;
end;
$$;
grant select, insert, update, delete on public.note_drive_credentials to service_role;
notify pgrst, 'reload schema';
commit;
