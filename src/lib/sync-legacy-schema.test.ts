import 'fake-indexeddb/auto';
import { PGlite } from '@electric-sql/pglite';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { db, newBoard, newFolder } from './db';
import { saveCloudRecord } from './sync-save';
import { syncWorkspace } from './sync';

const owner = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const boardId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const schema = readFileSync(new URL('../../supabase/schema.sql', import.meta.url), 'utf8');
const repair = readFileSync(new URL('../../supabase/repair-creation-dates.sql', import.meta.url), 'utf8');
const settings = { imageStore: 'supabase' as const, ocrEnabled: false, theme: 'light' as const };
let pg: PGlite;
let requests: { method: string; path: string }[];
let client: SupabaseClient;
const payload = { id: boardId, name: 'Week 3', folder_id: null, elements: [{ id: 'text', text: 'Do not lose this' }], app_state: {}, asset_ids: [], deleted: false, created_at: '2026-10-16T12:00:00Z', created_at_estimated: false };

async function asOwner() {
  await pg.exec('reset role');
  await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [owner]);
  await pg.exec('set role authenticated');
}
// Exercise the actual Supabase request builder against PostgreSQL, including
// its conditional REST updates, casts, triggers, constraints, and RLS policies.
const fetchDatabase: typeof fetch = async (input, init) => {
  const url = new URL(String(input)), method = init?.method || 'GET';
  requests.push({ method, path: url.pathname });
  try {
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    let rows: any[];
    if (url.pathname.endsWith('/rpc/save_note')) {
      rows = (await pg.query<{ result: any }>('select public.save_note($1, $2::jsonb, $3) as result', [body.p_kind, JSON.stringify(body.p_record), body.p_expected_revision])).rows;
      return Response.json(rows[0].result);
    }
    const table = url.pathname.split('/').at(-1)!;
    if (!['note_boards', 'note_folders', 'note_assets'].includes(table)) throw new Error('Unexpected table');
    const values: unknown[] = [], filters: string[] = [];
    for (const [key, value] of url.searchParams) {
      if (!['id', 'owner_id', 'revision'].includes(key)) continue;
      if (!value.startsWith('eq.')) throw new Error('Unexpected filter');
      values.push(value.slice(3)); filters.push(`${key} = $${values.length}`);
    }
    const where = filters.length ? ` where ${filters.join(' and ')}` : '';
    if (method === 'GET') {
      const columns = url.searchParams.get('select') === 'id,revision' ? 'id,revision' : '*';
      rows = (await pg.query(`select ${columns} from public.${table}${where} order by id`, values)).rows;
    } else {
      const keys = Object.keys(body);
      if (keys.some(key => !/^[a-z_]+$/.test(key))) throw new Error('Unexpected column');
      values.push(JSON.stringify(body));
      const record = `jsonb_populate_record(null::public.${table}, $${values.length}::jsonb)`;
      const query = method === 'POST'
        ? `insert into public.${table} (${keys.join(',')}) select ${keys.map(key => `(r).${key}`).join(',')} from ${record} r returning *`
        : `update public.${table} set ${keys.map(key => `${key} = (select (r).${key} from ${record} r)`).join(',')}${where} returning *`;
      rows = (await pg.query(query, values)).rows;
    }
    return Response.json(rows);
  } catch (error: any) { return Response.json({ message: error.message, code: error.code }, { status: 400 }); }
};
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`create role anon; create role authenticated;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema public, auth, storage to authenticated, anon;
    create table storage.buckets(id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
    create table storage.objects(id uuid primary key, bucket_id text, name text);
    create function storage.foldername(name text) returns text[] language sql immutable as $$ select string_to_array(name, '/') $$;
    insert into auth.users values ('${owner}'), ('${other}');`);
  client = createClient('https://database.invalid', 'test-public-key', { global: { fetch: fetchDatabase }, auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
}, 30000);
beforeEach(async () => {
  vi.stubGlobal('navigator', { onLine: true });
  requests = [];
  await pg.exec('reset role; drop table if exists public.note_boards, public.note_folders, public.note_assets cascade');
  await pg.exec(schema);
  await asOwner();
});
afterEach(async () => { await Promise.all([db.boards.clear(), db.folders.clear(), db.assets.clear()]); vi.unstubAllGlobals(); });
afterAll(async () => { await pg?.close(); });
async function removeColumns(keepTriggers = false) {
  await pg.exec('reset role');
  if (!keepTriggers) await pg.exec('drop trigger note_board_creation on public.note_boards; drop trigger note_folder_creation on public.note_folders');
  await pg.exec('alter table public.note_boards drop column created_at, drop column created_at_estimated; alter table public.note_folders drop column created_at, drop column created_at_estimated');
  await asOwner();
}
it('uploads and updates an old-schema board, then downloads it on another device with its folder', async () => {
  await removeColumns();
  const folder = await newFolder(owner, 'School', null);
  const board = await newBoard(owner, 'Week 3', folder.id);
  await db.boards.update(board.key, { elements: payload.elements });
  expect(await syncWorkspace(client, owner, settings, vi.fn())).toMatchObject({ complete: true, pending: 0 });
  expect(await db.boards.get(board.key)).toMatchObject({ dirty: false, createdAt: board.createdAt, createdAtEstimated: false, remoteRevision: 1 });
  await db.boards.update(board.key, { name: 'Week 3 updated', dirty: true });
  expect(await syncWorkspace(client, owner, settings, vi.fn())).toMatchObject({ complete: true });
  const { rows } = await pg.query<any>('select * from public.note_boards');
  expect(rows[0]).toMatchObject({ revision: 2, elements: payload.elements, name: 'Week 3 updated' });
  expect(Number.isFinite(Date.parse(rows[0].updated_at))).toBe(true); // REST "now" is cast on the database.
  await db.boards.clear(); await db.folders.clear(); // A second device has no local cache.
  expect(await syncWorkspace(client, owner, settings, vi.fn())).toMatchObject({ complete: true });
  expect(await db.boards.get(board.key)).toMatchObject({ name: 'Week 3 updated', elements: payload.elements, createdAtEstimated: true, remoteRevision: 2 });
  expect(await db.folders.get(folder.key)).toMatchObject({ name: 'School' });
});
it('does not overwrite a newer revision or insert over an existing board on the fallback', async () => {
  await removeColumns();
  expect((await saveCloudRecord(client, owner, 'board', payload, 0, () => {})).data).toMatchObject({ revision: 1 });
  expect((await saveCloudRecord(client, owner, 'board', { ...payload, name: 'Newer' }, 1, () => {})).data).toMatchObject({ revision: 2 });
  for (const revision of [0, 1]) expect((await saveCloudRecord(client, owner, 'board', payload, revision, () => {})).error?.message).toBe('NOTE_CONFLICT');
  expect((await pg.query<any>('select name, revision from public.note_boards')).rows[0]).toEqual({ name: 'Newer', revision: 2 });
});
it('keeps cross-account RLS checks and does not fall back for unrelated errors', async () => {
  await removeColumns();
  expect((await saveCloudRecord(client, other, 'board', payload, 0, () => {})).error?.message).toMatch(/row-level security/);
  requests = [];
  const denied = await saveCloudRecord(client, owner, 'board', { ...payload, name: '' }, 0, () => {});
  expect(denied.error?.message).toMatch(/check constraint/);
  expect(requests.filter(request => request.method === 'POST' && request.path.endsWith('/note_boards'))).toHaveLength(1);
  await pg.exec('reset role'); await pg.exec(repair); await asOwner(); requests = [];
  expect((await saveCloudRecord(client, owner, 'board', { ...payload, name: '' }, 0, () => {})).error?.message).toMatch(/check constraint/);
  expect(requests).toHaveLength(1); // Current schema: no REST retry for a constraint failure.
});
it('stops before the compatibility write if the active account changes', async () => {
  await removeColumns();
  await expect(saveCloudRecord(client, owner, 'board', payload, 0, () => { throw new Error('Account changed'); })).rejects.toThrow('Account changed');
  expect(requests).toHaveLength(1);
  expect((await pg.query('select * from public.note_boards')).rows).toHaveLength(0);
});
it.each(['repair', 'full schema'])('repairs a partially upgraded database with installed triggers using %s', async (script) => {
  await saveCloudRecord(client, owner, 'board', payload, 0, () => {});
  await removeColumns(true);
  // This is the exact screenshot failure, produced by the real SQL function.
  const broken = await client.rpc('save_note', { p_kind: 'board', p_record: payload, p_expected_revision: 0 });
  expect(broken.error).toMatchObject({ code: '42703', message: 'column "created_at" of relation "note_boards" does not exist' });
  const blocked = await saveCloudRecord(client, owner, 'board', { ...payload, name: 'Changed' }, 1, () => {});
  expect(blocked.error?.message).toMatch(/record "old" has no field "created_at"/);
  const before = (await pg.query<any>('select * from public.note_boards')).rows[0];
  await pg.exec('reset role');
  await pg.exec(script === 'repair' ? repair : schema);
  await pg.exec(script === 'repair' ? repair : schema);
  await asOwner();
  const after = (await pg.query<any>('select * from public.note_boards')).rows[0];
  expect(after).toMatchObject({ ...before, created_at: before.updated_at, created_at_estimated: true });
  const saved = await saveCloudRecord(client, owner, 'board', { ...payload, name: 'Changed' }, 1, () => {});
  expect(saved.data).toMatchObject({ name: 'Changed', revision: 2, created_at_estimated: false });
  expect(new Date(saved.data.created_at).toISOString()).toBe('2026-10-16T12:00:00.000Z');
});
it('repairs a missing date even with a stale precise-date flag and leaves intact dates unchanged', async () => {
  await saveCloudRecord(client, owner, 'board', payload, 0, () => {});
  const original = (await pg.query<any>('select * from public.note_boards')).rows[0];
  await pg.exec('reset role; alter table public.note_boards drop column created_at');
  await pg.exec(repair); await asOwner();
  const repaired = (await pg.query<any>('select * from public.note_boards')).rows[0];
  expect(repaired).toMatchObject({ ...original, created_at: original.updated_at, created_at_estimated: true });
  await saveCloudRecord(client, owner, 'board', payload, 1, () => {});
  const precise = (await pg.query<any>('select * from public.note_boards')).rows[0];
  await pg.exec('reset role'); await pg.exec(repair); await asOwner();
  expect((await pg.query<any>('select * from public.note_boards')).rows[0]).toEqual(precise);
});
