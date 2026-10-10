import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let pg: PGlite;
const userA = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const userB = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const parent = '11111111-1111-4111-8111-111111111111';
const child = '22222222-2222-4222-8222-222222222222';
const board = '33333333-3333-4333-8333-333333333333';
async function asUser(id: string) {
  await pg.exec('reset role');
  await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [id]);
  await pg.exec('set role authenticated');
}
async function save(kind: string, record: object, revision: number) {
  const result = await pg.query<{ result: any }>('select public.save_note($1, $2::jsonb, $3) as result', [kind, JSON.stringify(record), revision]);
  return result.rows[0].result;
}
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth, storage, public to authenticated, anon;
    grant execute on function auth.uid() to authenticated, anon;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid primary key, bucket_id text, name text);
    alter table storage.objects enable row level security;
    grant select, insert, update on storage.objects to authenticated;
    create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
    insert into auth.users values ('${userA}'), ('${userB}');
  `);
  const schema = readFileSync(new URL('../../supabase/schema.sql', import.meta.url), 'utf8');
  await pg.exec(schema);
  await pg.exec(schema); // Migration must also be safe to rerun.
}, 30000);
afterAll(async () => { await pg?.close(); });
describe('Supabase schema and access isolation', () => {
  it('creates a folder, its child, and a board as the signed-in owner', async () => {
    await asUser(userA);
    const root = await save('folder', { id: parent, name: 'Projects', parent_id: null, color: '#b6a5e5' }, 0);
    expect(root.owner_id).toBe(userA); expect(root.revision).toBe(1);
    await save('folder', { id: child, name: 'Research', parent_id: parent, color: '#b6a5e5' }, 0);
    const saved = await save('board', { id: board, name: 'My board', folder_id: child, elements: [], app_state: {}, asset_ids: [], deleted: false }, 0);
    expect(saved.revision).toBe(1);
  });
  it('rejects stale saves and accepts the correct revision', async () => {
    await asUser(userA);
    await expect(save('board', { id: board, name: 'Stale board', folder_id: child, elements: [], app_state: {}, asset_ids: [], deleted: false }, 0)).rejects.toThrow('NOTE_CONFLICT');
    const updated = await save('board', { id: board, name: 'Updated board', folder_id: child, elements: [], app_state: {}, asset_ids: [], deleted: false }, 1);
    expect(updated.revision).toBe(2);
  });
  it('prevents another user from reading or updating an owner’s boards and folders', async () => {
    await asUser(userB);
    expect((await pg.query('select * from public.note_boards')).rows).toHaveLength(0);
    expect((await pg.query('select * from public.note_folders')).rows).toHaveLength(0);
    await expect(save('board', { id: board, name: 'Unauthorized', folder_id: null, elements: [], app_state: {}, asset_ids: [], deleted: false }, 2)).rejects.toThrow('NOTE_CONFLICT');
  });
  it('rejects cross-account folder references and cycles', async () => {
    await asUser(userB);
    await expect(save('folder', { id: '44444444-4444-4444-8444-444444444444', name: 'Other user child', parent_id: parent, color: '#aaa' }, 0)).rejects.toThrow();
    await asUser(userA);
    await expect(save('folder', { id: parent, name: 'Projects', parent_id: child, color: '#b6a5e5' }, 1)).rejects.toThrow('descendants');
  });
  it('keeps image metadata and storage objects private to their owner', async () => {
    await asUser(userA);
    await pg.query("insert into public.note_assets(owner_id,id,mime_type,created_ms,storage,remote_path) values ($1,'image','image/png',1,'drive','drive-file-id')", [userA]);
    await pg.query("insert into storage.objects(id,bucket_id,name) values ('55555555-5555-4555-8555-555555555555','note-images',$1)", [`${userA}/image`]);
    await asUser(userB);
    expect((await pg.query('select * from public.note_assets')).rows).toHaveLength(0);
    expect((await pg.query('select * from storage.objects')).rows).toHaveLength(0);
    await expect(pg.query("insert into storage.objects(id,bucket_id,name) values ('66666666-6666-4666-8666-666666666666','note-images',$1)", [`${userA}/sneaky`])).rejects.toThrow();
  });
  it('denies anonymous reads and saves', async () => {
    await pg.exec('reset role');
    await pg.query("select set_config('request.jwt.claim.sub', '', false)");
    await pg.exec('set role anon');
    await expect(pg.query('select * from public.note_boards')).rejects.toThrow('permission denied');
    await expect(save('board', { id: board }, 2)).rejects.toThrow('permission denied');
  });
});
