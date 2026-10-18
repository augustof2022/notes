import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';

const owner = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const upgrade = readFileSync(new URL('../../supabase/enable-permanent-trash.sql', import.meta.url), 'utf8');
let pg: PGlite;
async function asUser(id: string) {
  await pg.exec('reset role');
  await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  await pg.exec('set role authenticated');
}
async function save(kind: string, data: object, revision = 0) {
  return (await pg.query<{ result: any }>('select public.save_note($1,$2::jsonb,$3) result', [kind, JSON.stringify(data), revision])).rows[0].result;
}
async function folder(parent_id: string | null = null, deleted = true) {
  return save('folder', { id: crypto.randomUUID(), name: 'Folder to remove', color: '#aaa', parent_id, deleted });
}
async function board(folder_id: string | null = null, deleted = true, asset_ids = ['shared-image']) {
  return save('board', { id: crypto.randomUUID(), name: 'Private board content', folder_id, deleted, elements: [{ id: 'secret', text: 'Erase me' }], app_state: { zoom: 2 }, asset_ids });
}
async function purge(folders: any[], boards: any[]) {
  const selected = (items: any[]) => JSON.stringify(items.map(item => ({ id: item.id, revision: item.revision })));
  return (await pg.query<{ result: any }>('select public.purge_note_trash($1::jsonb,$2::jsonb) result', [selected(folders), selected(boards)])).rows[0].result;
}
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`create role anon; create role authenticated; create schema auth; create schema storage;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth,storage,public to authenticated,anon;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key,bucket_id text,name text);
    create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name,'/') $$;
    insert into auth.users values ('${owner}'),('${other}');`);
  await pg.exec(readFileSync(new URL('../../supabase/schema.sql', import.meta.url), 'utf8'));
  await asUser(owner);
}, 30000);
afterAll(async () => { await pg?.close(); });
it('upgrades an existing installation without changing Trash data and is safe to rerun', async () => {
  const existing = await board();
  await pg.exec('reset role; drop trigger note_board_purge_guard on public.note_boards; drop trigger note_folder_purge_guard on public.note_folders; alter table public.note_boards drop column purged; alter table public.note_folders drop column purged;');
  await pg.exec(upgrade); await pg.exec(upgrade);
  await asUser(owner);
  expect((await pg.query<any>('select * from public.note_boards where id=$1', [existing.id])).rows[0]).toMatchObject({ name: existing.name, revision: 1, deleted: true, purged: false, elements: existing.elements, asset_ids: existing.asset_ids });
});
it('erases selected contents, keeps shared images and other boards, and returns inert tombstones', async () => {
  const removed = await board(), retained = await board(null, false);
  await pg.query("insert into public.note_assets(id,mime_type,created_ms,storage,remote_path) values ('shared-image','image/png',1,'drive','file')");
  const result = await purge([], [removed]);
  expect(result.boards).toEqual([expect.objectContaining({ id: removed.id, purged: true, deleted: true, name: 'Deleted board', folder_id: null, elements: [], app_state: {}, asset_ids: [], revision: 2 })]);
  expect((await pg.query<any>('select * from public.note_boards where id=$1', [retained.id])).rows[0]).toMatchObject({ purged: false, elements: retained.elements, asset_ids: ['shared-image'] });
  expect((await pg.query('select * from public.note_assets')).rows).toHaveLength(1);
  // Retry after a lost response is harmless even with the original revision.
  expect(await purge([], [removed])).toEqual(result);
});
it('prevents stale RPC saves, direct updates, and reinsertion from resurrecting a deleted ID', async () => {
  const removed = await board(); await purge([], [removed]);
  await expect(save('board', { ...removed, deleted: false }, 1)).rejects.toThrow('NOTE_CONFLICT');
  await expect(save('board', { ...removed, deleted: false }, 2)).rejects.toThrow('NOTE_PURGED');
  await expect(pg.query('update public.note_boards set purged=false, deleted=false, elements=$1::jsonb where id=$2', [JSON.stringify(removed.elements), removed.id])).rejects.toThrow('NOTE_PURGED');
  await expect(save('board', { ...removed, deleted: false }, 0)).rejects.toThrow('NOTE_CONFLICT');
});
it('atomically deletes a complete trashed subtree and blocks future children in a purged folder', async () => {
  const root = await folder(), child = await folder(root.id), nested = await board(child.id);
  const result = await purge([root, child], [nested]);
  expect(result.folders).toHaveLength(2);
  expect(result.folders.every((row: any) => row.purged && row.parent_id === null)).toBe(true);
  await expect(board(root.id, false)).rejects.toThrow('NOTE_PURGED_FOLDER');
  await expect(folder(child.id, false)).rejects.toThrow('NOTE_PURGED_FOLDER');
});
it('rejects a stale Empty Trash snapshot after a restore, keeping every selected board intact', async () => {
  const first = await board(), restored = await board();
  await save('board', { ...restored, deleted: false }, restored.revision);
  await expect(purge([], [first, restored])).rejects.toThrow('NOTE_TRASH_CHANGED');
  expect((await pg.query<any>('select purged from public.note_boards where id=$1', [first.id])).rows[0].purged).toBe(false);
});
it('rejects newly added and omitted descendants rather than erase unseen boards', async () => {
  const root = await folder(), original = await board(root.id), added = await board(root.id, false);
  await expect(purge([root], [original])).rejects.toThrow('NOTE_TRASH_CHANGED');
  expect((await pg.query<any>('select purged from public.note_boards where id=$1', [original.id])).rows[0].purged).toBe(false);
  expect((await pg.query<any>('select deleted from public.note_boards where id=$1', [added.id])).rows[0].deleted).toBe(false);
  await expect(pg.query('update public.note_folders set purged=true where id=$1', [root.id])).rejects.toThrow('NOTE_TRASH_CHANGED');
});
it('creates a deletion marker for an unpublished local ID, but never deletes an existing active ID', async () => {
  const id = crypto.randomUUID();
  const result = await purge([], [{ id, revision: 0 }]);
  expect(result.boards[0]).toMatchObject({ id, purged: true, revision: 1 });
  const active = await board(null, false);
  await expect(purge([], [{ id: active.id, revision: 0 }])).rejects.toThrow('NOTE_TRASH_CHANGED');
});
it('keeps purge operations private to their owner and denies anonymous execution', async () => {
  const protectedBoard = await board();
  await asUser(other);
  await expect(purge([], [protectedBoard])).rejects.toThrow('NOTE_TRASH_CHANGED');
  expect((await pg.query('select * from public.note_boards')).rows).toHaveLength(0);
  await expect(purge([], [{ id: protectedBoard.id, revision: 0 }])).rejects.toThrow('NOTE_TRASH_CHANGED');
  await pg.exec('reset role; set role anon');
  await expect(purge([], [protectedBoard])).rejects.toThrow('permission denied');
  await asUser(owner);
});
