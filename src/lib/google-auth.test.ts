import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { createAuthStorage } from './auth-storage';
import { disconnectDrive, downloadDriveImage, DRIVE_SCOPE, driveConnected, googleSignInUrl, uploadDriveImage, useGoogleDriveSession } from './drive';

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
function session(owner = 'note-user-a', subject = 'google-user-a', token = 'test-google-token') {
  return { user: { id: owner, identities: [{ provider: 'google', identity_data: { sub: subject } }] }, provider_token: token } as unknown as Session;
}
function json(value: unknown, status = 200) { return new Response(JSON.stringify(value), { status }); }
afterEach(() => { disconnectDrive(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Google login and private Drive ownership', () => {
  it('keeps Google tokens in memory while persisting only the Note login', () => {
    const disk = memoryStorage(), storage = createAuthStorage(disk);
    storage.setItem('auth', JSON.stringify({ user: { id: 'a' }, access_token: 'note-session', refresh_token: 'note-refresh', provider_token: 'google-session', provider_refresh_token: 'google-refresh' }));
    expect(disk.getItem('auth')).not.toContain('google-session');
    expect(disk.getItem('auth')).not.toContain('google-refresh');
    expect(JSON.parse(storage.getItem('auth')!).provider_token).toBe('google-session');
    expect(JSON.parse(createAuthStorage(disk).getItem('auth')!).provider_token).toBeUndefined();
    expect(JSON.parse(disk.getItem('auth')!).refresh_token).toBe('note-refresh');
  });
  it('drops provider credentials when the Note account changes or signs out', () => {
    const storage = createAuthStorage(memoryStorage());
    storage.setItem('auth', JSON.stringify({ user: { id: 'a' }, provider_token: 'google-a' }));
    storage.setItem('auth', JSON.stringify({ user: { id: 'b' } }));
    expect(JSON.parse(storage.getItem('auth')!).provider_token).toBeUndefined();
    storage.setItem('verifier', JSON.stringify('pkce-verifier'));
    expect(storage.getItem('verifier')).toBe(JSON.stringify('pkce-verifier'));
    storage.removeItem('auth'); expect(storage.getItem('auth')).toBeNull();
  });
  it('requests Google login and Drive permission in the same OAuth flow', async () => {
    const signInWithOAuth = vi.fn().mockResolvedValue({ data: { url: 'https://example.supabase.co/auth/v1/authorize' }, error: null });
    const client = { auth: { signInWithOAuth } } as unknown as SupabaseClient;
    await googleSignInUrl(client, 'https://example.github.io/notes/', 'person@example.com');
    expect(signInWithOAuth).toHaveBeenCalledWith(expect.objectContaining({ provider: 'google', options: expect.objectContaining({ scopes: DRIVE_SCOPE, redirectTo: 'https://example.github.io/notes/', skipBrowserRedirect: true, queryParams: expect.objectContaining({ login_hint: 'person@example.com' }) }) }));
  });
  it('blocks uploads and downloads from a different Note account before any Drive request', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(json({ sub: 'google-user-a' })).mockResolvedValueOnce(json({ user: {} }));
    vi.stubGlobal('fetch', fetchMock);
    expect(await useGoogleDriveSession(session())).toBe(true);
    expect(driveConnected('note-user-a')).toBe(true); expect(driveConnected('note-user-b')).toBe(false);
    await expect(downloadDriveImage('private-file', 'note-user-b')).rejects.toThrow('Reconnect');
    await expect(uploadDriveImage('image', 'note-user-b', new Blob(['test']))).rejects.toThrow('Reconnect');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('rejects a Google token belonging to a different Google identity', async () => {
    const fetchMock = vi.fn().mockResolvedValue(json({ sub: 'someone-else' })); vi.stubGlobal('fetch', fetchMock);
    await expect(useGoogleDriveSession(session())).rejects.toThrow('Google account');
    expect(driveConnected()).toBe(false); expect(fetchMock).toHaveBeenCalledTimes(1);
  });
  it('leaves uploads pending if the person declines Drive permission', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ sub: 'google-user-a' })).mockResolvedValueOnce(json({}, 403)));
    await expect(useGoogleDriveSession(session())).rejects.toThrow('permission');
    expect(driveConnected()).toBe(false);
  });
  it('does not restore an old connection if sign-out happens during Google verification', async () => {
    let resolveProfile!: (response: Response) => void;
    const profile = new Promise<Response>(resolve => { resolveProfile = resolve; });
    vi.stubGlobal('fetch', vi.fn().mockReturnValueOnce(profile).mockResolvedValue(json({ user: {} })));
    const checking = useGoogleDriveSession(session());
    await useGoogleDriveSession(null); resolveProfile(json({ sub: 'google-user-a' }));
    expect(await checking).toBe(false); expect(driveConnected()).toBe(false);
  });
  it('requires reconnection after the Google access window expires', async () => {
    vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-10T00:00:00Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(json({ sub: 'google-user-a' })).mockResolvedValueOnce(json({ user: {} })));
    await useGoogleDriveSession(session());
    vi.setSystemTime(new Date('2026-10-10T00:51:00Z'));
    expect(driveConnected('note-user-a')).toBe(false);
    await expect(downloadDriveImage('image', 'note-user-a')).rejects.toThrow('Reconnect');
  });
});
