-- Run once in your Supabase SQL Editor. Re-running this script is safe.
-- No service-role key belongs in the browser app.
create table if not exists public.note_folders (
  id uuid primary key,
  owner_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  name text not null check (length(name) between 1 and 200),
  parent_id uuid,
  color text not null default '#b6a5e5',
  deleted boolean not null default false,
  purged boolean not null default false,
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
  purged boolean not null default false,
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
-- Temporarily remove creation guards so partially upgraded rows can be backfilled.
-- Both guards are restored below after the columns and values are complete.
drop trigger if exists note_folder_creation on public.note_folders;
drop trigger if exists note_board_creation on public.note_boards;
alter table public.note_folders add column if not exists created_at timestamptz;
alter table public.note_folders add column if not exists created_at_estimated boolean;
alter table public.note_boards add column if not exists created_at timestamptz;
alter table public.note_boards add column if not exists created_at_estimated boolean;
update public.note_folders set created_at = coalesce(created_at, updated_at), created_at_estimated = case when created_at is null then true else coalesce(created_at_estimated, true) end where created_at is null or created_at_estimated is null;
update public.note_boards set created_at = coalesce(created_at, updated_at), created_at_estimated = case when created_at is null then true else coalesce(created_at_estimated, true) end where created_at is null or created_at_estimated is null;
alter table public.note_folders alter column created_at set default now(), alter column created_at set not null, alter column created_at_estimated set default false, alter column created_at_estimated set not null;
alter table public.note_boards alter column created_at set default now(), alter column created_at set not null, alter column created_at_estimated set default false, alter column created_at_estimated set not null;
alter table public.note_folders add column if not exists purged boolean not null default false;
alter table public.note_boards add column if not exists purged boolean not null default false;
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
  if old.created_at is not null and old.created_at_estimated is not null
    and not (old.created_at_estimated and not new.created_at_estimated) then
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

-- Retain only an inert deletion marker so an old/offline device cannot recreate
-- permanently deleted content. These markers remain private under the same RLS.
create or replace function public.guard_note_purge()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(new.owner_id::text, 0));
  if tg_op = 'UPDATE' and old.purged then raise exception 'NOTE_PURGED'; end if;
  if new.purged then
    new.deleted := true;
    if tg_table_name = 'note_boards' then
      new.name := 'Deleted board'; new.folder_id := null;
      new.elements := '[]'::jsonb; new.app_state := '{}'::jsonb; new.asset_ids := '{}'::text[];
    else
      if exists (select 1 from public.note_folders where parent_id = new.id and owner_id = new.owner_id and not purged)
        or exists (select 1 from public.note_boards where folder_id = new.id and owner_id = new.owner_id and not purged)
        then raise exception 'NOTE_TRASH_CHANGED'; end if;
      new.name := 'Deleted folder'; new.parent_id := null; new.color := '#b6a5e5';
    end if;
  elsif tg_table_name = 'note_boards' then
    if exists (select 1 from public.note_folders where id = new.folder_id and owner_id = new.owner_id and purged)
      then raise exception 'NOTE_PURGED_FOLDER'; end if;
  else
    if exists (select 1 from public.note_folders where id = new.parent_id and owner_id = new.owner_id and purged)
      then raise exception 'NOTE_PURGED_FOLDER'; end if;
  end if;
  return new;
end;
$$;
drop trigger if exists note_board_purge_guard on public.note_boards;
create trigger note_board_purge_guard before insert or update on public.note_boards for each row execute function public.guard_note_purge();
drop trigger if exists note_folder_purge_guard on public.note_folders;
create trigger note_folder_purge_guard before insert or update on public.note_folders for each row execute function public.guard_note_purge();

-- The client sends only the Trash entries it displayed, with their revisions.
-- Validate that snapshot atomically; a concurrent restore/edit must survive.
create or replace function public.purge_note_trash(p_folders jsonb, p_boards jsonb)
returns jsonb language plpgsql security invoker set search_path = '' as $$
declare
  uid uuid := auth.uid(); item record; current_row record; saved jsonb;
  folders_result jsonb := '[]'::jsonb; boards_result jsonb := '[]'::jsonb;
  folder_ids uuid[]; board_ids uuid[]; remaining integer; removed integer;
begin
  if uid is null then raise exception 'Sign in before deleting Trash.'; end if;
  if jsonb_typeof(p_folders) is distinct from 'array' or jsonb_typeof(p_boards) is distinct from 'array'
    then raise exception 'Invalid Trash selection.'; end if;
  perform pg_advisory_xact_lock(hashtextextended(uid::text, 0));
  select coalesce(array_agg(distinct id), '{}'::uuid[]) into folder_ids from jsonb_to_recordset(p_folders) as x(id uuid, revision bigint);
  select coalesce(array_agg(distinct id), '{}'::uuid[]) into board_ids from jsonb_to_recordset(p_boards) as x(id uuid, revision bigint);
  if exists (select 1 from jsonb_to_recordset(p_folders || p_boards) as x(id uuid, revision bigint) where id is null or revision is null or revision < 0)
    then raise exception 'Invalid Trash selection.'; end if;

  for item in select * from jsonb_to_recordset(p_folders) as x(id uuid, revision bigint) loop
    select * into current_row from public.note_folders where id = item.id and owner_id = uid;
    if found then
      if not current_row.purged and (not current_row.deleted or current_row.revision <> item.revision)
        then raise exception 'NOTE_TRASH_CHANGED'; end if;
    elsif item.revision <> 0 then raise exception 'NOTE_TRASH_CHANGED';
    else
      insert into public.note_folders(id, owner_id, name, deleted, purged) values (item.id, uid, 'Deleted folder', true, true)
        on conflict (id) do nothing returning to_jsonb(note_folders.*) into saved;
      if saved is null then raise exception 'NOTE_TRASH_CHANGED'; end if;
    end if;
  end loop;
  for item in select * from jsonb_to_recordset(p_boards) as x(id uuid, revision bigint) loop
    select * into current_row from public.note_boards where id = item.id and owner_id = uid;
    if found then
      if not current_row.purged and (not current_row.deleted or current_row.revision <> item.revision)
        then raise exception 'NOTE_TRASH_CHANGED'; end if;
    elsif item.revision <> 0 then raise exception 'NOTE_TRASH_CHANGED';
    else
      insert into public.note_boards(id, owner_id, name, deleted, purged) values (item.id, uid, 'Deleted board', true, true)
        on conflict (id) do nothing returning to_jsonb(note_boards.*) into saved;
      if saved is null then raise exception 'NOTE_TRASH_CHANGED'; end if;
    end if;
  end loop;
  -- Every immediate child must be selected, which also covers all descendants.
  -- New children and boards restored by another device are never silently erased.
  if exists (select 1 from public.note_folders where owner_id = uid and parent_id = any(folder_ids) and not purged and not (id = any(folder_ids)))
    or exists (select 1 from public.note_boards where owner_id = uid and folder_id = any(folder_ids) and not purged and not (id = any(board_ids)))
    then raise exception 'NOTE_TRASH_CHANGED'; end if;

  update public.note_boards set purged = true, revision = revision + 1, updated_at = now()
    where owner_id = uid and id = any(board_ids) and not purged;
  -- Delete leaf folders first so the same guard also protects direct REST writes.
  loop
    select count(*) into remaining from public.note_folders where owner_id = uid and id = any(folder_ids) and not purged;
    exit when remaining = 0;
    update public.note_folders f set purged = true, revision = revision + 1, updated_at = now()
      where f.owner_id = uid and f.id = any(folder_ids) and not f.purged
      and not exists (select 1 from public.note_folders c where c.owner_id = uid and c.parent_id = f.id and not c.purged);
    get diagnostics removed = row_count;
    if removed = 0 then raise exception 'NOTE_TRASH_CHANGED'; end if;
  end loop;
  select coalesce(jsonb_agg(to_jsonb(f)), '[]'::jsonb) into folders_result from public.note_folders f where owner_id = uid and id = any(folder_ids);
  select coalesce(jsonb_agg(to_jsonb(b)), '[]'::jsonb) into boards_result from public.note_boards b where owner_id = uid and id = any(board_ids);
  return jsonb_build_object('folders', folders_result, 'boards', boards_result);
end;
$$;
revoke all on function public.purge_note_trash(jsonb, jsonb) from public, anon;
grant execute on function public.purge_note_trash(jsonb, jsonb) to authenticated;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('note-images', 'note-images', false, 20971520, array['image/png','image/jpeg','image/webp','image/gif','image/svg+xml'])
on conflict (id) do nothing;
drop policy if exists note_images_select on storage.objects;
create policy note_images_select on storage.objects for select to authenticated using (bucket_id = 'note-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists note_images_insert on storage.objects;
create policy note_images_insert on storage.objects for insert to authenticated with check (bucket_id = 'note-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
drop policy if exists note_images_update on storage.objects;
create policy note_images_update on storage.objects for update to authenticated using (bucket_id = 'note-images' and (storage.foldername(name))[1] = (select auth.uid())::text) with check (bucket_id = 'note-images' and (storage.foldername(name))[1] = (select auth.uid())::text);
