-- Run in Supabase SQL Editor to enable Delete permanently and Empty Trash.
-- Safe to rerun. Existing boards, folders, image files, and access policies are preserved.
begin;
alter table public.note_folders add column if not exists purged boolean not null default false;
alter table public.note_boards add column if not exists purged boolean not null default false;

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

notify pgrst, 'reload schema';
commit;
