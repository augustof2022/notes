-- Run once in your Supabase SQL Editor. Re-running this script is safe.
-- No service-role key belongs in the browser app.
create table if not exists public.note_folders (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(name) between 1 and 200),
  parent_id uuid,
  color text not null default '#b6a5e5',
  deleted boolean not null default false,
  revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_at_estimated boolean not null default false,
  unique (id, owner_id),
  foreign key (parent_id, owner_id) references public.note_folders(id, owner_id),
  check (parent_id is distinct from id)
);
create table if not exists public.note_boards (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(name) between 1 and 200),
  folder_id uuid,
  elements jsonb not null default '[]',
  app_state jsonb not null default '{}',
  asset_ids text[] not null default '{}',
  deleted boolean not null default false,
  revision bigint not null default 1,
  updated_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  created_at_estimated boolean not null default false,
  foreign key (folder_id, owner_id) references public.note_folders(id, owner_id)
);
create table if not exists public.note_assets (
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  id text not null,
  mime_type text not null,
  created_ms bigint not null,
  storage text not null check (storage in ('supabase', 'drive')),
  remote_path text not null,
  ocr_text text not null default '',
  ocr_status text not null default 'done' check (ocr_status in ('pending', 'done', 'failed')),
  primary key (owner_id, id)
);
-- Older installations did not store creation times. Preserve their last edit
-- as an explicitly marked estimate instead of claiming a new/original date.
-- A prior release backfilled created_at without a provenance flag, so any
-- existing unflagged date is conservatively an estimate as well.
alter table public.note_folders add column if not exists created_at timestamptz;
alter table public.note_folders add column if not exists created_at_estimated boolean;
alter table public.note_boards add column if not exists created_at timestamptz;
alter table public.note_boards add column if not exists created_at_estimated boolean;
update public.note_folders set created_at = coalesce(created_at, updated_at), created_at_estimated = coalesce(created_at_estimated, true) where created_at is null or created_at_estimated is null;
update public.note_boards set created_at = coalesce(created_at, updated_at), created_at_estimated = coalesce(created_at_estimated, true) where created_at is null or created_at_estimated is null;
alter table public.note_folders alter column created_at set default now(), alter column created_at set not null, alter column created_at_estimated set default false, alter column created_at_estimated set not null;
alter table public.note_boards alter column created_at set default now(), alter column created_at set not null, alter column created_at_estimated set default false, alter column created_at_estimated set not null;
create index if not exists note_folders_owner on public.note_folders(owner_id);
create index if not exists note_boards_owner on public.note_boards(owner_id);
alter table public.note_folders enable row level security;
alter table public.note_boards enable row level security;
alter table public.note_assets enable row level security;
revoke all on public.note_folders, public.note_boards, public.note_assets from anon;
grant select, insert, update on public.note_folders, public.note_boards, public.note_assets to authenticated;
-- Soft deletion supports the in-app Trash; direct DELETE is deliberately not granted.
drop policy if exists own_folders on public.note_folders;
create policy own_folders on public.note_folders for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists own_boards on public.note_boards;
create policy own_boards on public.note_boards for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));
drop policy if exists own_assets on public.note_assets;
create policy own_assets on public.note_assets for all to authenticated using (owner_id = (select auth.uid())) with check (owner_id = (select auth.uid()));

create or replace function public.check_note_folder_cycle()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  -- Serialize hierarchy mutations for one owner so concurrent moves cannot create a cycle.
  perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text, 0));
  if new.parent_id is not null and exists (
    with recursive ancestors as (
      select f.id, f.parent_id from public.note_folders f where f.id = new.parent_id and f.owner_id = new.owner_id
      union
      select f.id, f.parent_id from public.note_folders f join ancestors a on f.id = a.parent_id where f.owner_id = new.owner_id
    ) select 1 from ancestors where id = new.id
  ) then raise exception 'A folder cannot be moved into itself or its descendants.'; end if;
  return new;
end;
$$;
drop trigger if exists note_folder_cycle on public.note_folders;
create trigger note_folder_cycle before insert or update of parent_id on public.note_folders for each row execute function public.check_note_folder_cycle();

create or replace function public.keep_note_creation()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  -- A device that retained the real time may repair a migration estimate once.
  -- After that, ordinary edits and later metadata cannot rewrite creation.
  if not (old.created_at_estimated and not new.created_at_estimated) then
    new.created_at := old.created_at;
    new.created_at_estimated := old.created_at_estimated;
  end if;
  return new;
end;
$$;
drop trigger if exists note_folder_creation on public.note_folders;
create trigger note_folder_creation before update on public.note_folders for each row execute function public.keep_note_creation();
drop trigger if exists note_board_creation on public.note_boards;
create trigger note_board_creation before update on public.note_boards for each row execute function public.keep_note_creation();

create or replace function public.save_note(p_kind text, p_record jsonb, p_expected_revision bigint)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare result jsonb; uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Sign in before syncing.'; end if;
  if p_kind = 'folder' then
    if p_expected_revision = 0 then
      insert into public.note_folders(id, owner_id, name, parent_id, color, deleted, created_at, created_at_estimated)
      values ((p_record->>'id')::uuid, uid, p_record->>'name', (p_record->>'parent_id')::uuid, p_record->>'color', coalesce((p_record->>'deleted')::boolean, false), coalesce((p_record->>'created_at')::timestamptz, now()), coalesce((p_record->>'created_at_estimated')::boolean, false))
      on conflict (id) do nothing returning to_jsonb(note_folders.*) into result;
    else
      update public.note_folders set name = p_record->>'name', parent_id = (p_record->>'parent_id')::uuid, color = p_record->>'color', deleted = coalesce((p_record->>'deleted')::boolean, false), revision = revision + 1, updated_at = now(),
        created_at = case when created_at_estimated and p_record->>'created_at' is not null and p_record->>'created_at_estimated' = 'false' then (p_record->>'created_at')::timestamptz else created_at end,
        created_at_estimated = case when p_record->>'created_at' is not null and p_record->>'created_at_estimated' = 'false' then false else created_at_estimated end
      where id = (p_record->>'id')::uuid and owner_id = uid and revision = p_expected_revision returning to_jsonb(note_folders.*) into result;
    end if;
  elsif p_kind = 'board' then
    if p_expected_revision = 0 then
      insert into public.note_boards(id, owner_id, name, folder_id, elements, app_state, asset_ids, deleted, created_at, created_at_estimated)
      values ((p_record->>'id')::uuid, uid, p_record->>'name', (p_record->>'folder_id')::uuid, p_record->'elements', p_record->'app_state', array(select jsonb_array_elements_text(p_record->'asset_ids')), coalesce((p_record->>'deleted')::boolean, false), coalesce((p_record->>'created_at')::timestamptz, now()), coalesce((p_record->>'created_at_estimated')::boolean, false))
      on conflict (id) do nothing returning to_jsonb(note_boards.*) into result;
    else
      update public.note_boards set name = p_record->>'name', folder_id = (p_record->>'folder_id')::uuid, elements = p_record->'elements', app_state = p_record->'app_state', asset_ids = array(select jsonb_array_elements_text(p_record->'asset_ids')), deleted = coalesce((p_record->>'deleted')::boolean, false), revision = revision + 1, updated_at = now(),
        created_at = case when created_at_estimated and p_record->>'created_at' is not null and p_record->>'created_at_estimated' = 'false' then (p_record->>'created_at')::timestamptz else created_at end,
        created_at_estimated = case when p_record->>'created_at' is not null and p_record->>'created_at_estimated' = 'false' then false else created_at_estimated end
      where id = (p_record->>'id')::uuid and owner_id = uid and revision = p_expected_revision returning to_jsonb(note_boards.*) into result;
    end if;
  else raise exception 'Unknown record type.';
  end if;
  if result is null then raise exception 'NOTE_CONFLICT'; end if;
  return result;
end;
$$;
revoke all on function public.save_note(text, jsonb, bigint) from public, anon;
grant execute on function public.save_note(text, jsonb, bigint) to authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('note-images', 'note-images', false, 20971520, array['image/png','image/jpeg','image/webp','image/gif','image/svg+xml'])
on conflict (id) do nothing;
drop policy if exists note_images_select on storage.objects;
create policy note_images_select on storage.objects for select to authenticated using (bucket_id = 'note-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists note_images_insert on storage.objects;
create policy note_images_insert on storage.objects for insert to authenticated with check (bucket_id = 'note-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists note_images_update on storage.objects;
create policy note_images_update on storage.objects for update to authenticated using (bucket_id = 'note-images' and (storage.foldername(name))[1] = (select auth.uid())::text) with check (bucket_id = 'note-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
