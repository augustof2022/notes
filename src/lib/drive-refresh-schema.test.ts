import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../supabase/enable-drive-refresh.sql', import.meta.url), 'utf8');
const owner = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const removedOwner = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const firstVersion = '11111111-1111-4111-8111-111111111111';
const secondVersion = '22222222-2222-4222-8222-222222222222';
let pg: PGlite;
async function asRole(role: 'anon' | 'authenticated' | 'service_role', user = owner) {
  await pg.exec('reset role');
  await pg.query("select set_config('request.jwt.claim.sub', $1, false)", [user]);
  await pg.exec(`set role ${role}`);
}
beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth;
    create table auth.users(id uuid primary key);
    grant usage on schema public, auth to authenticated, anon, service_role;
    insert into auth.users values ('${owner}'), ('${other}'), ('${removedOwner}');
  `);
  await pg.exec(migration);
}, 30000);
afterAll(async () => { await pg?.close(); });
it('stores only bounded ciphertext with an owner identity and caller-controlled CAS version', async () => {
  await asRole('service_role');
  await pg.query('insert into public.note_drive_credentials(owner_id,google_subject,version,encrypted_payload) values ($1,$2,$3,$4)', [owner, 'google-owner', firstVersion, 'encrypted-envelope']);
  const { rows } = await pg.query<any>('select * from public.note_drive_credentials where owner_id=$1', [owner]);
  expect(rows[0]).toMatchObject({ owner_id: owner, google_subject: 'google-owner', version: firstVersion, encrypted_payload: 'encrypted-envelope' });
  expect(Number.isFinite(new Date(rows[0].updated_at).getTime())).toBe(true);
  const columns = (await pg.query<{ column_name: string }>("select column_name from information_schema.columns where table_schema='public' and table_name='note_drive_credentials' order by ordinal_position")).rows.map(row => row.column_name);
  expect(columns).toEqual(['owner_id', 'google_subject', 'version', 'encrypted_payload', 'updated_at']);
  await expect(pg.query('insert into public.note_drive_credentials(owner_id,google_subject,version,encrypted_payload) values ($1,$2,$3,$4)', [other, '', secondVersion, 'ciphertext'])).rejects.toThrow('check constraint');
  await expect(pg.query('insert into public.note_drive_credentials(owner_id,google_subject,version,encrypted_payload) values ($1,$2,$3,$4)', [other, 'google-other', secondVersion, 'x'.repeat(65537)])).rejects.toThrow('check constraint');
});
it('denies anonymous and signed-in users every table operation, including their own credentials', async () => {
  for (const role of ['anon', 'authenticated'] as const) {
    for (const user of [owner, other]) {
      await asRole(role, user);
      await expect(pg.query('select * from public.note_drive_credentials where owner_id=$1', [user])).rejects.toThrow('permission denied');
      await expect(pg.query('insert into public.note_drive_credentials(owner_id,google_subject,version,encrypted_payload) values ($1,$2,$3,$4)', [user, 'google-sub', secondVersion, 'ciphertext'])).rejects.toThrow('permission denied');
      await expect(pg.query('update public.note_drive_credentials set encrypted_payload=$1 where owner_id=$2', ['changed', user])).rejects.toThrow('permission denied');
      await expect(pg.query('delete from public.note_drive_credentials where owner_id=$1', [user])).rejects.toThrow('permission denied');
    }
  }
});
it('supports conditional renewal and deletion without stale requests overwriting newer credentials', async () => {
  await asRole('service_role');
  const updated = await pg.query('update public.note_drive_credentials set version=$1, encrypted_payload=$2 where owner_id=$3 and version=$4 returning *', [secondVersion, 'new-encrypted-envelope', owner, firstVersion]);
  expect(updated.rows).toHaveLength(1);
  expect((await pg.query('update public.note_drive_credentials set encrypted_payload=$1 where owner_id=$2 and version=$3 returning *', ['stale-token', owner, firstVersion])).rows).toHaveLength(0);
  expect((await pg.query('delete from public.note_drive_credentials where owner_id=$1 and version=$2 returning *', [owner, firstVersion])).rows).toHaveLength(0);
  expect((await pg.query<any>('select * from public.note_drive_credentials where owner_id=$1', [owner])).rows[0]).toMatchObject({ version: secondVersion, encrypted_payload: 'new-encrypted-envelope' });
});
it('reruns safely, preserves existing ciphertext, and leaves no user-facing access policy', async () => {
  await pg.exec('reset role');
  // A previous/manual setup must not accidentally expose credentials on rerun.
  await pg.exec('grant select on public.note_drive_credentials to authenticated; create policy accidental_access on public.note_drive_credentials for select to authenticated using (true)');
  await pg.exec(migration); await pg.exec(migration);
  await asRole('service_role');
  expect((await pg.query<any>('select * from public.note_drive_credentials where owner_id=$1', [owner])).rows[0]).toMatchObject({ version: secondVersion, encrypted_payload: 'new-encrypted-envelope' });
  await pg.exec('reset role');
  expect((await pg.query("select * from pg_policies where schemaname='public' and tablename='note_drive_credentials'")).rows).toHaveLength(0);
  await asRole('authenticated');
  await expect(pg.query('select * from public.note_drive_credentials')).rejects.toThrow('permission denied');
});
it('removes encrypted credentials when the Note account is deleted and permits server-only disconnect', async () => {
  await asRole('service_role');
  await pg.query('insert into public.note_drive_credentials(owner_id,google_subject,version,encrypted_payload) values ($1,$2,$3,$4)', [removedOwner, 'google-deleted', firstVersion, 'encrypted-envelope']);
  await pg.exec('reset role');
  await pg.query('delete from auth.users where id=$1', [removedOwner]);
  await asRole('service_role');
  expect((await pg.query('select * from public.note_drive_credentials where owner_id=$1', [removedOwner])).rows).toHaveLength(0);
  expect((await pg.query('delete from public.note_drive_credentials where owner_id=$1 and version=$2 returning *', [owner, secondVersion])).rows).toHaveLength(1);
});
