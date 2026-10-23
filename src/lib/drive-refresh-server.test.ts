import { beforeEach, expect, it, vi } from 'vitest';
import { createDriveSessionHandler, type CredentialRow, type CredentialStore, type DriveSessionDependencies } from '../../supabase/functions/drive-session/handler';
import { decryptTokens, encryptTokens, importTokenKey } from '../../supabase/functions/drive-session/crypto';

const origin = 'https://augustof2022.github.io';
const owner = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa', other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const scope = 'https://www.googleapis.com/auth/drive.file';
const instant = Date.parse('2026-10-23T12:00:00Z');
let key: CryptoKey;
beforeEach(async () => { key = await importTokenKey(btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))); });
function fixture() {
  let clock = instant, exchanges = 0;
  const rows = new Map<string, CredentialRow>();
  const store: CredentialStore = {
    read: vi.fn(async owner => structuredClone(rows.get(owner) || null)),
    insert: vi.fn(async row => { if (rows.has(row.owner_id)) return false; rows.set(row.owner_id, structuredClone(row)); return true; }),
    replace: vi.fn(async (row, version) => { if (rows.get(row.owner_id)?.version !== version) return false; rows.set(row.owner_id, structuredClone(row)); return true; })
  };
  const fetcher = vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/token')) return Response.json({ access_token: `google-access-${++exchanges}`, expires_in: 3600, scope });
    if (url.endsWith('/userinfo')) return Response.json({ sub: 'google-owner' });
    if (url.includes('/drive/v3/about')) return Response.json({ user: { permissionId: 'drive-user' } });
    throw new Error('Unexpected request');
  });
  const deps: DriveSessionDependencies = {
    store, key, clientId: 'google-client-id', clientSecret: 'dummy-server-secret', allowedOrigins: [origin], fetcher, now: () => clock,
    authenticate: vi.fn(async jwt => jwt === 'owner-jwt' ? { id: owner, role: 'authenticated', identities: [{ provider: 'google', identity_data: { sub: 'google-owner' } }] }
      : jwt === 'other-jwt' ? { id: other, role: 'authenticated', identities: [{ provider: 'google', identity_data: { sub: 'google-other' } }] }
      : jwt === 'service-jwt' ? { id: owner, role: 'service_role', identities: [{ provider: 'google', identity_data: { sub: 'google-owner' } }] } : null)
  };
  const handle = createDriveSessionHandler(deps);
  function request(body: unknown, jwt = 'owner-jwt', requestOrigin: string | null = origin) {
    return handle(new Request('https://project.supabase.co/functions/v1/drive-session', {
      method: 'POST', headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json', ...(requestOrigin ? { origin: requestOrigin } : {}) }, body: JSON.stringify(body)
    }));
  }
  async function connect() { const response = await request({ action: 'connect', provider_refresh_token: 'private-google-refresh' }); expect(response.status).toBe(200); return response.json(); }
  return { rows, store, fetcher, deps, handle, request, connect, advance(ms: number) { clock += ms; } };
}
it('stores only encrypted credentials and returns only a short-lived access session', async () => {
  const f = fixture(), result = await f.connect();
  expect(result).toEqual({ access_token: 'google-access-1', expires_at: instant + 3600000, google_subject: 'google-owner', renewable: true });
  const row = f.rows.get(owner)!;
  expect(JSON.stringify(row)).not.toContain('private-google-refresh'); expect(JSON.stringify(row)).not.toContain('google-access-1');
  expect(await decryptTokens(key, owner, 'google-owner', row.encrypted_payload)).toEqual({ refresh_token: 'private-google-refresh', access_token: 'google-access-1', expires_at: instant + 3600000 });
  expect(JSON.stringify(result)).not.toContain('refresh'); expect(JSON.stringify(result)).not.toContain('dummy-server-secret');
  const refreshRequest = f.fetcher.mock.calls.find(([url]) => String(url).endsWith('/token'))!;
  expect(String(refreshRequest[1]?.body)).toContain('client_secret=dummy-server-secret');
});
it('reuses encrypted access after reload, renews before expiry, and only forces the rejected current token', async () => {
  const f = fixture(), first = await f.connect(); f.fetcher.mockClear();
  const reloaded = createDriveSessionHandler(f.deps);
  const cached = await reloaded(new Request('https://project.supabase.co/functions/v1/drive-session', { method: 'POST', headers: { authorization: 'Bearer owner-jwt', 'content-type': 'application/json', origin }, body: JSON.stringify({ action: 'token' }) }));
  expect(await cached.json()).toEqual(first); expect(f.fetcher).not.toHaveBeenCalled();
  expect(await (await f.request({ action: 'token', rejected_token: 'an-old-token' })).json()).toEqual(first);
  expect(f.fetcher).not.toHaveBeenCalled();
  const forced = await (await f.request({ action: 'token', rejected_token: first.access_token })).json();
  expect(forced.access_token).toBe('google-access-2'); expect(f.fetcher).toHaveBeenCalledTimes(3);
  f.fetcher.mockClear(); f.advance(59 * 60000);
  expect((await (await f.request({ action: 'token' })).json()).access_token).toBe('google-access-3');
  expect(f.fetcher).toHaveBeenCalledTimes(3);
});
it('validates the freshly exchanged token subject instead of trusting a paired frontend token or owner', async () => {
  const f = fixture();
  f.fetcher.mockImplementation(async input => String(input).endsWith('/token') ? Response.json({ access_token: 'another-person-access', expires_in: 3600, scope }) : Response.json({ sub: 'google-someone-else' }));
  const response = await f.request({ action: 'connect', owner_id: other, provider_refresh_token: 'someone-else-refresh', provider_token: 'own-correct-access' });
  expect(response.status).toBe(403); expect((await response.json()).error).toBe('drive_account_mismatch');
  expect(f.rows.size).toBe(0);
});
it('isolates caller-owned rows and rejects anon, API-key-like, service-role, and invalid JWT callers', async () => {
  const f = fixture(); await f.connect();
  const otherResponse = await f.request({ action: 'token', owner_id: owner }, 'other-jwt');
  expect(otherResponse.status).toBe(409); expect(f.rows.size).toBe(1);
  for (const jwt of ['invalid-jwt', 'sb_publishable_key', 'service-jwt']) expect((await f.request({ action: 'token' }, jwt)).status).toBe(401);
  const response = await f.handle(new Request('https://project.supabase.co/functions/v1/drive-session', { method: 'POST', headers: { apikey: 'public-key', 'content-type': 'application/json' }, body: '{"action":"token"}' }));
  expect(response.status).toBe(401);
});
it('requires Drive permission before storing a grant', async () => {
  const f = fixture();
  f.fetcher.mockImplementation(async input => String(input).endsWith('/token') ? Response.json({ access_token: 'access', expires_in: 3600, scope: 'openid email' }) : Response.json({ sub: 'google-owner' }));
  expect((await f.request({ action: 'connect', provider_refresh_token: 'refresh' })).status).toBe(403); expect(f.rows.size).toBe(0);
  f.fetcher.mockImplementation(async input => String(input).endsWith('/token') ? Response.json({ access_token: 'access', expires_in: 3600, scope }) : String(input).endsWith('/userinfo') ? Response.json({ sub: 'google-owner' }) : Response.json({}, { status: 403 }));
  expect((await f.request({ action: 'connect', provider_refresh_token: 'refresh' })).status).toBe(403); expect(f.rows.size).toBe(0);
});
it('retains grants for transient failures, but clears only the matching revoked grant', async () => {
  const f = fixture(); await f.connect(); const before = f.rows.get(owner)!; f.advance(60 * 60000);
  f.fetcher.mockRejectedValue(new Error('network error includes private-google-refresh'));
  const temporary = await f.request({ action: 'token' });
  expect(temporary.status).toBe(503); expect(await temporary.json()).toEqual({ error: 'drive_temporarily_unavailable', message: 'Google Drive is temporarily unavailable. Retry in a moment.' });
  expect(f.rows.get(owner)).toEqual(before);
  f.fetcher.mockResolvedValue(Response.json({ error: 'invalid_grant', error_description: 'secret details' }, { status: 400 }));
  const revoked = await f.request({ action: 'token' }); expect(revoked.status).toBe(409);
  const cleared = f.rows.get(owner)!;
  expect(cleared.version).not.toBe(before.version);
  expect(await decryptTokens(key, owner, 'google-owner', cleared.encrypted_payload)).toEqual({ refresh_token: '', access_token: '', expires_at: 0 });
});
it('cannot recreate credentials when disconnect wins against an in-flight initial connect', async () => {
  const f = fixture();
  let release!: () => void, started!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; }), begun = new Promise<void>(resolve => { started = resolve; });
  const original = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (input, init) => { if (String(input).endsWith('/token')) { started(); await waiting; } return original(input, init); });
  const connecting = f.request({ action: 'connect', provider_refresh_token: 'private-google-refresh' });
  await begun;
  expect((await f.request({ action: 'disconnect' })).status).toBe(200);
  release(); expect((await connecting).status).toBe(409);
  const marker = f.rows.get(owner)!; expect((await decryptTokens(key, owner, 'google-owner', marker.encrypted_payload)).refresh_token).toBe('');
});
it('cannot save a refreshed token after disconnect, and an old invalid_grant cannot erase a newer connect', async () => {
  const f = fixture(); await f.connect(); f.advance(60 * 60000);
  let release!: () => void, started!: () => void;
  let waiting = new Promise<void>(resolve => { release = resolve; }), begun = new Promise<void>(resolve => { started = resolve; });
  const original = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (input, init) => { if (String(input).endsWith('/token')) { started(); await waiting; } return original(input, init); });
  const pending = f.request({ action: 'token' }); await begun;
  expect((await f.request({ action: 'disconnect' })).status).toBe(200);
  release(); expect((await pending).status).toBe(409);
  f.fetcher.mockImplementation(original); await f.connect(); f.advance(60 * 60000);
  waiting = new Promise<void>(resolve => { release = resolve; }); begun = new Promise<void>(resolve => { started = resolve; });
  f.fetcher.mockImplementation(async () => { started(); await waiting; return Response.json({ error: 'invalid_grant' }, { status: 400 }); });
  const stale = f.request({ action: 'token' }); await begun;
  f.fetcher.mockImplementation(original); const newer = await f.connect(); const newerVersion = f.rows.get(owner)!.version;
  release(); expect(await (await stale).json()).toEqual(newer); expect(f.rows.get(owner)!.version).toBe(newerVersion);
});
it('coalesces concurrent renewals and reuses a newer cache when another server wins the CAS', async () => {
  const f = fixture(); await f.connect(); f.advance(60 * 60000); f.fetcher.mockClear();
  const responses = await Promise.all([f.request({ action: 'token' }), f.request({ action: 'token' }), f.request({ action: 'token' })]);
  const values = await Promise.all(responses.map(response => response.json()));
  expect(values.every(value => value.access_token === values[0].access_token)).toBe(true);
  expect(f.fetcher).toHaveBeenCalledTimes(3);
  f.advance(60 * 60000);
  const otherHandler = createDriveSessionHandler(f.deps);
  const secondRequest = new Request('https://project.supabase.co/functions/v1/drive-session', { method: 'POST', headers: { authorization: 'Bearer owner-jwt', 'content-type': 'application/json', origin }, body: '{"action":"token"}' });
  const races = await Promise.all([f.request({ action: 'token' }), otherHandler(secondRequest)]);
  const raceValues = await Promise.all(races.map(response => response.json()));
  expect(raceValues[0]).toEqual(raceValues[1]);
});
it('uses authenticated encryption bound to account and Google subject and detects tampering', async () => {
  const tokens = { refresh_token: 'private-refresh', access_token: 'private-access', expires_at: instant + 3600000 };
  const first = await encryptTokens(key, owner, 'google-owner', tokens), second = await encryptTokens(key, owner, 'google-owner', tokens);
  expect(first).not.toBe(second); expect(await decryptTokens(key, owner, 'google-owner', first)).toEqual(tokens);
  await expect(decryptTokens(key, other, 'google-owner', first)).rejects.toThrow();
  await expect(decryptTokens(key, owner, 'google-other', first)).rejects.toThrow();
  const pieces = first.split('.'); pieces[2] = (pieces[2][0] === 'A' ? 'B' : 'A') + pieces[2].slice(1);
  await expect(decryptTokens(key, owner, 'google-owner', pieces.join('.'))).rejects.toThrow();
});
it('restricts origins, rejects malformed/oversized requests, and marks every response no-store', async () => {
  const f = fixture();
  const rejected = await f.request({ action: 'token' }, 'owner-jwt', 'https://attacker.example');
  expect(rejected.status).toBe(403); expect(rejected.headers.get('access-control-allow-origin')).toBeNull(); expect(f.deps.authenticate).not.toHaveBeenCalled();
  const preflight = await f.handle(new Request('https://project.supabase.co/functions/v1/drive-session', { method: 'OPTIONS', headers: { origin } }));
  expect(preflight.status).toBe(204); expect(preflight.headers.get('access-control-allow-origin')).toBe(origin);
  const oversized = await f.request({ action: 'connect', provider_refresh_token: 'x'.repeat(17000) }); expect(oversized.status).toBe(413);
  const invalid = await f.handle(new Request('https://project.supabase.co/functions/v1/drive-session', { method: 'POST', headers: { origin, authorization: 'Bearer owner-jwt', 'content-type': 'application/json' }, body: 'not json' })); expect(invalid.status).toBe(400);
  const valid = await f.request({ action: 'token' }); expect(valid.headers.get('cache-control')).toContain('no-store'); expect(valid.headers.get('access-control-allow-origin')).toBe(origin);
});
it('distinguishes missing setup from temporary failures without exposing server errors', async () => {
  const f = fixture();
  vi.mocked(f.store.read).mockRejectedValue({ code: '42P01', message: 'table public.note_drive_credentials missing private details' });
  const missing = await f.request({ action: 'token' }); expect(missing.status).toBe(503); expect((await missing.json()).error).toBe('drive_setup_required');
  vi.mocked(f.store.read).mockRejectedValue(new Error('database unreachable private secret'));
  const outage = await f.request({ action: 'token' }); expect(outage.status).toBe(503); expect(await outage.text()).not.toContain('private secret');
  const unconfigured = createDriveSessionHandler({ ...f.deps, clientSecret: '' });
  const response = await unconfigured(new Request('https://project.supabase.co/functions/v1/drive-session', { method: 'POST', headers: { authorization: 'Bearer owner-jwt', 'content-type': 'application/json', origin }, body: '{"action":"token"}' }));
  expect((await response.json()).error).toBe('drive_setup_required');
});

it('times out a stalled Google response body and treats auth-service outages as retryable', async () => {
  const f = fixture();
  vi.useFakeTimers();
  try {
    f.fetcher.mockImplementation(async (_input, init) => new Response(new ReadableStream({
      start(controller) { init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true }); }
    }), { headers: { 'content-type': 'application/json' } }));
    const pending = f.request({ action: 'connect', provider_refresh_token: 'private-refresh' });
    await vi.advanceTimersByTimeAsync(15001);
    const response = await pending;
    expect(response.status).toBe(503); expect((await response.json()).error).toBe('drive_temporarily_unavailable');
    expect(f.rows.size).toBe(0);
  } finally { vi.useRealTimers(); }
  vi.mocked(f.deps.authenticate).mockRejectedValue(new Error('auth server offline with private details'));
  const unavailable = await f.request({ action: 'token' });
  expect(unavailable.status).toBe(503); expect((await unavailable.json()).error).toBe('drive_temporarily_unavailable');
});

it('does not ask for reconnection when Google uses HTTP 403 for a temporary rate limit', async () => {
  const f = fixture(); await f.connect(); f.advance(60 * 60000);
  const existing = structuredClone(f.rows.get(owner));
  const original = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (input, init) => String(input).includes('/drive/v3/about')
    ? Response.json({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, { status: 403 }) : original(input, init));
  const response = await f.request({ action: 'token' });
  expect(response.status).toBe(503); expect((await response.json()).error).toBe('drive_temporarily_unavailable');
  expect(f.rows.get(owner)).toEqual(existing);
  f.fetcher.mockImplementation(async (input, init) => String(input).endsWith('/userinfo')
    ? Response.json({ error: { errors: [{ reason: 'dailyLimitExceeded' }] } }, { status: 403 }) : original(input, init));
  const profileQuota = await f.request({ action: 'token' });
  expect(profileQuota.status).toBe(503); expect((await profileQuota.json()).error).toBe('drive_temporarily_unavailable');
  expect(f.rows.get(owner)).toEqual(existing);
});

it('rejects a Google expiration outside the shared frontend 65-minute lease contract', async () => {
  const f = fixture();
  const original = f.fetcher.getMockImplementation()!;
  f.fetcher.mockImplementation(async (input, init) => String(input).endsWith('/token')
    ? Response.json({ access_token: 'access', expires_in: 7200, scope }) : original(input, init));
  const response = await f.request({ action: 'connect', provider_refresh_token: 'refresh' });
  expect(response.status).toBe(503); expect((await response.json()).error).toBe('drive_temporarily_unavailable');
  expect(f.rows.size).toBe(0);
});
