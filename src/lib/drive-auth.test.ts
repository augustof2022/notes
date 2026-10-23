import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { appConfig } from '../config';

type Manager = typeof import('./drive-auth');
let drive: Manager;
let disk: ReturnType<typeof memoryStorage>;
const owner = 'note-user-a', subject = 'google-user-a';
const cacheKey = `note-drive-access-v1:${appConfig.supabaseUrl}`;
function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
function session(token?: string, refresh?: string, noteOwner = owner, googleSubject = subject): Session {
  return { user: { id: noteOwner, identities: [{ provider: 'google', identity_data: { sub: googleSubject } }] }, ...(token ? { provider_token: token } : {}), ...(refresh ? { provider_refresh_token: refresh } : {}) } as unknown as Session;
}
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status }); }
function lease(token = 'server-access-a', minutes = 60) {
  return { access_token: token, google_subject: subject, expires_at: Date.now() + minutes * 60000, renewable: true };
}
function unavailable(status: number, code: string) {
  return { data: null, error: { context: json({ error: code }, status) } };
}
function clientWith(invoke: ReturnType<typeof vi.fn>) { return { functions: { invoke } } as unknown as SupabaseClient; }
function verificationFetch(googleSubject = subject) {
  const fetcher = vi.fn(async (url: RequestInfo | URL) => json(String(url).includes('userinfo') ? { sub: googleSubject } : { user: {} }));
  vi.stubGlobal('fetch', fetcher); return fetcher;
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-23T12:00:00Z'));
  disk = memoryStorage(); vi.stubGlobal('localStorage', disk); vi.stubGlobal('navigator', { onLine: true }); vi.stubGlobal('document', { visibilityState: 'visible' });
  drive = await import('./drive-auth');
});
afterEach(() => { drive.disconnectDrive(); vi.clearAllTimers(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('renewable Drive access manager', () => {
  it('requests an offline grant during the explicit Google connection flow', async () => {
    const signInWithOAuth = vi.fn().mockResolvedValue({ data: { url: 'https://example.supabase.co/auth/v1/authorize' }, error: null });
    await drive.googleSignInUrl({ auth: { signInWithOAuth } } as unknown as SupabaseClient, 'https://example.github.io/notes/', 'person@example.com');
    expect(signInWithOAuth).toHaveBeenCalledWith(expect.objectContaining({ provider: 'google', options: expect.objectContaining({ scopes: drive.DRIVE_SCOPE, queryParams: expect.objectContaining({ access_type: 'offline', prompt: expect.stringContaining('consent'), login_hint: 'person@example.com' }) }) }));
  });
  it('hands the grant to the server once and never downgrades a renewed lease when OAuth data is repeated', async () => {
    const fetcher = verificationFetch();
    const invoke = vi.fn().mockResolvedValue({ data: lease(), error: null }), client = clientWith(invoke);
    const original = session('oauth-access', 'offline-grant');
    expect(await drive.useGoogleDriveSession(original, client)).toBe(true);
    expect(await drive.useGoogleDriveSession(session(), client)).toBe(true);
    expect(await drive.useGoogleDriveSession(original, client)).toBe(true);
    expect(await drive.ensureDriveAccess(owner)).toMatchObject({ token: 'server-access-a' });
    expect(drive.getDriveStatus()).toMatchObject({ phase: 'connected', renewable: true });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith('drive-session', { body: { action: 'connect', provider_refresh_token: 'offline-grant' } });
    expect(fetcher).not.toHaveBeenCalled();
    expect(disk.getItem(cacheKey)).not.toContain('offline-grant');
  });
  it('uses the saved server grant when Google returns a fresh access token without a refresh token', async () => {
    const fetcher = verificationFetch();
    const invoke = vi.fn().mockResolvedValue({ data: lease('saved-server-access'), error: null });
    expect(await drive.useGoogleDriveSession(session('fresh-oauth-without-refresh'), clientWith(invoke))).toBe(true);
    expect(await drive.ensureDriveAccess(owner)).toMatchObject({ token: 'saved-server-access' });
    expect(drive.getDriveStatus()).toMatchObject({ phase: 'connected', renewable: true });
    expect(invoke).toHaveBeenCalledWith('drive-session', { body: { action: 'token' } });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('preserves healthy renewable access when a later OAuth event supplies only a different access token', async () => {
    const fetcher = verificationFetch();
    const invoke = vi.fn().mockResolvedValue({ data: lease('healthy-server-access'), error: null }), client = clientWith(invoke);
    await drive.useGoogleDriveSession(session('first-oauth', 'offline-grant'), client);
    expect(await drive.useGoogleDriveSession(session('different-oauth-without-refresh'), client)).toBe(true);
    expect(await drive.ensureDriveAccess(owner)).toMatchObject({ token: 'healthy-server-access' });
    expect(drive.getDriveStatus()).toMatchObject({ renewable: true });
    expect(invoke).toHaveBeenCalledTimes(1); expect(fetcher).not.toHaveBeenCalled();
  });
  it('coalesces initialization and access requests while account verification is pending', async () => {
    const profile = deferred<Response>();
    const fetcher = vi.fn().mockReturnValueOnce(profile.promise).mockResolvedValue(json({ user: {} })); vi.stubGlobal('fetch', fetcher);
    const first = drive.useGoogleDriveSession(session('oauth-access'));
    const second = drive.useGoogleDriveSession(session('oauth-access'));
    const access = drive.ensureDriveAccess(owner);
    profile.resolve(json({ sub: subject }));
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(await access).toMatchObject({ token: 'oauth-access' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('restores verified short-lived access after a reload when server setup is temporarily missing', async () => {
    verificationFetch(); await drive.useGoogleDriveSession(session('oauth-access'));
    const before = JSON.parse(disk.getItem(cacheKey)!);
    vi.setSystemTime(new Date(Date.now() + 20 * 60000)); vi.resetModules();
    drive = await import('./drive-auth');
    const invoke = vi.fn().mockResolvedValue(unavailable(404, 'NOT_FOUND'));
    expect(await drive.useGoogleDriveSession(session(), clientWith(invoke))).toBe(true);
    expect(drive.driveConnected(owner)).toBe(true);
    expect(drive.getDriveStatus()).toMatchObject({ setupNeeded: true });
    expect(JSON.parse(disk.getItem(cacheKey)!).expiresAt).toBe(before.expiresAt);
  });
  it('verifies a restored short-lived token against the current Google identity', async () => {
    verificationFetch(); await drive.useGoogleDriveSession(session('oauth-access'));
    vi.resetModules(); drive = await import('./drive-auth'); verificationFetch('someone-else');
    await expect(drive.useGoogleDriveSession(session())).rejects.toThrow('Google account');
    expect(drive.driveConnected(owner)).toBe(false); expect(disk.getItem(cacheKey)).toBeNull();
  });
  it('renews an expired lease without another Google sign-in or a reset of its old expiry', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ data: lease('first-access', 5), error: null });
    await drive.useGoogleDriveSession(session('oauth-access', 'offline-grant'), clientWith(invoke));
    vi.setSystemTime(new Date(Date.now() + 6 * 60000));
    invoke.mockResolvedValue({ data: lease('renewed-access'), error: null });
    expect(await drive.ensureDriveAccess(owner)).toMatchObject({ token: 'renewed-access' });
    expect(invoke).toHaveBeenLastCalledWith('drive-session', { body: { action: 'token' } });
    expect(drive.getDriveStatus()).toMatchObject({ phase: 'connected', renewable: true });
  });
  it('coalesces concurrent rejected-token renewals and ignores late failures from the previous token', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ data: lease('first-access'), error: null });
    await drive.useGoogleDriveSession(session('oauth-access', 'offline-grant'), clientWith(invoke));
    const renewal = deferred<{ data: ReturnType<typeof lease>; error: null }>(); invoke.mockReturnValue(renewal.promise);
    const first = drive.ensureDriveAccess(owner, 'first-access'), second = drive.ensureDriveAccess(owner, 'first-access');
    renewal.resolve({ data: lease('renewed-access'), error: null });
    expect((await Promise.all([first, second])).map(result => result.token)).toEqual(['renewed-access', 'renewed-access']);
    drive.driveAccessRejected(owner, 'first-access');
    expect(drive.driveConnected(owner)).toBe(true);
    expect(await drive.ensureDriveAccess(owner, 'first-access')).toMatchObject({ token: 'renewed-access' });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
  it('keeps valid access during a transient background renewal failure and does not request consent', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ data: lease('first-access', 10), error: null });
    await drive.useGoogleDriveSession(session('oauth-access', 'offline-grant'), clientWith(invoke));
    invoke.mockResolvedValue(unavailable(503, 'drive_temporarily_unavailable'));
    await vi.advanceTimersByTimeAsync(8 * 60000);
    expect(drive.driveConnected(owner)).toBe(true);
    expect(await drive.ensureDriveAccess(owner)).toMatchObject({ token: 'first-access' });
    expect(drive.getDriveStatus().phase).not.toBe('reconnect');
    expect(drive.getDriveStatus().setupNeeded).toBe(false);
  });
  it('retries a transient first verification without another OAuth flow or extending its original expiry', async () => {
    const firstExpiry = Date.now() + 50 * 60000;
    const fetcher = verificationFetch(); fetcher.mockResolvedValueOnce(json({}, 503));
    await expect(drive.useGoogleDriveSession(session('oauth-access'))).rejects.toThrow('temporarily unavailable');
    const calls = fetcher.mock.calls.length;
    await expect(drive.ensureDriveAccess(owner)).rejects.toThrow('temporarily unavailable');
    expect(fetcher).toHaveBeenCalledTimes(calls);
    vi.setSystemTime(new Date(Date.now() + 31000));
    expect(await drive.ensureDriveAccess(owner)).toMatchObject({ token: 'oauth-access' });
    expect(JSON.parse(disk.getItem(cacheKey)!).expiresAt).toBe(firstExpiry);
    expect(drive.getDriveStatus().phase).toBe('connected');
  });
  it('ends rejected access after a revoked grant and waits for a new consent flow', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ data: lease('first-access'), error: null });
    await drive.useGoogleDriveSession(session('oauth-access', 'offline-grant'), clientWith(invoke));
    invoke.mockResolvedValue(unavailable(409, 'drive_reconnect_required'));
    await expect(drive.ensureDriveAccess(owner, 'first-access')).rejects.toThrow('Reconnect');
    expect(drive.driveConnected(owner)).toBe(false); expect(disk.getItem(cacheKey)).toBeNull();
    expect(drive.getDriveStatus().phase).toBe('reconnect');
    const calls = invoke.mock.calls.length; vi.setSystemTime(new Date(Date.now() + 31000));
    await expect(drive.ensureDriveAccess(owner)).rejects.toThrow('Reconnect');
    expect(invoke).toHaveBeenCalledTimes(calls);
  });
  it('registers an explicitly renewed OAuth connection even when Google repeats the refresh grant value', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ data: lease('first-access'), error: null })
      .mockResolvedValueOnce(unavailable(409, 'drive_reconnect_required'))
      .mockResolvedValue({ data: lease('access-after-reconnect'), error: null });
    const client = clientWith(invoke);
    await drive.useGoogleDriveSession(session('first-oauth', 'same-offline-grant'), client);
    await expect(drive.ensureDriveAccess(owner, 'first-access')).rejects.toThrow('Reconnect');
    expect(await drive.useGoogleDriveSession(session('new-explicit-oauth', 'same-offline-grant'), client)).toBe(true);
    expect(invoke).toHaveBeenLastCalledWith('drive-session', { body: { action: 'connect', provider_refresh_token: 'same-offline-grant' } });
    expect(await drive.ensureDriveAccess(owner)).toMatchObject({ token: 'access-after-reconnect' });
    expect(drive.getDriveStatus()).toMatchObject({ phase: 'connected', renewable: true });
  });
  it('distinguishes an expired Note login from revoked Google permission', async () => {
    const invoke = vi.fn().mockResolvedValue(unavailable(401, 'unauthorized'));
    await expect(drive.useGoogleDriveSession(session(), clientWith(invoke))).rejects.toThrow('Note login');
    expect(drive.getDriveStatus().phase).not.toBe('reconnect');
  });
  it('blocks another Note account before issuing an access request', async () => {
    verificationFetch(); await drive.useGoogleDriveSession(session('oauth-access'));
    await expect(drive.ensureDriveAccess('note-user-b')).rejects.toThrow('Reconnect');
  });
  it('cannot restore old credentials when sign-out happens during verification', async () => {
    const profile = deferred<Response>(); vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(profile.promise).mockResolvedValue(json({ user: {} })));
    const connecting = drive.useGoogleDriveSession(session('oauth-access'));
    await drive.useGoogleDriveSession(null); profile.resolve(json({ sub: subject }));
    expect(await connecting).toBe(false); expect(drive.driveConnected()).toBe(false); expect(disk.getItem(cacheKey)).toBeNull();
  });
  it('rejects a token for the wrong Google identity or missing Drive permission', async () => {
    verificationFetch('wrong-google-user');
    await expect(drive.useGoogleDriveSession(session('oauth-access'))).rejects.toThrow('Google account');
    drive.disconnectDrive();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ sub: subject })).mockResolvedValueOnce(json({}, 403)));
    await expect(drive.useGoogleDriveSession(session('oauth-access'))).rejects.toThrow('permission');
    expect(drive.driveConnected()).toBe(false);
  });
});
