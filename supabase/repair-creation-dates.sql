-- Repair missing creation-date columns on an existing Note database.
-- Run the entire script in Supabase SQL Editor, then choose Sync now in Note.
-- Safe to rerun. Existing boards, files, revisions, edit times, and access
-- policies are preserved. Unknown original creation dates are marked estimates.
begin;
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

notify pgrst, 'reload schema';
commit;
