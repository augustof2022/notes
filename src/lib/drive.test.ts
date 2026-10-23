import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session, SupabaseClient } from '@supabase/supabase-js';

type Driver = typeof import('./drive');
type Manager = typeof import('./drive-auth');
let drive: Driver, manager: Manager;
const owner = 'note-user-a', subject = 'google-user-a';
function session(refresh = false) {
  return { user: { id: owner, identities: [{ provider: 'google', identity_data: { sub: subject } }] }, provider_token: 'oauth-access', ...(refresh ? { provider_refresh_token: 'offline-grant' } : {}) } as unknown as Session;
}
function json(data: unknown, status = 200) { return new Response(JSON.stringify(data), { status }); }
function lease(token: string) { return { access_token: token, expires_at: Date.now() + 3600000, google_subject: subject, renewable: true }; }
function clientWith(invoke: ReturnType<typeof vi.fn>) { return { functions: { invoke } } as unknown as SupabaseClient; }
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
const inputUrl = (input: RequestInfo | URL) => new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
function basicFetch(input: RequestInfo | URL) {
  const url = inputUrl(input);
  if (url.pathname.includes('userinfo')) return json({ sub: subject });
  if (url.pathname.endsWith('/about')) return json({ user: {} });
  if (url.pathname === '/drive/v3/files') return json({ files: url.searchParams.get('q')?.includes('mimeType=') ? [{ id: 'private-image-folder' }] : [] });
  if (url.pathname === '/upload/drive/v3/files') return json({ id: 'uploaded-image' });
  return new Response(new Blob(['image'], { type: 'image/png' }));
}
beforeEach(async () => {
  vi.resetModules(); vi.useFakeTimers(); vi.setSystemTime(new Date('2026-10-23T12:00:00Z'));
  const values = new Map<string, string>();
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } });
  vi.stubGlobal('navigator', { onLine: true }); vi.stubGlobal('document', { visibilityState: 'visible' });
  manager = await import('./drive-auth'); drive = await import('./drive');
});
afterEach(() => { drive.disconnectDrive(); vi.clearAllTimers(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('Drive image uploads and downloads', () => {
  it('waits for the same connection check before either uploading or downloading', async () => {
    const profile = deferred<Response>();
    const fetcher = vi.fn((input: RequestInfo | URL) => inputUrl(input).pathname.includes('userinfo') ? profile.promise : Promise.resolve(basicFetch(input)));
    vi.stubGlobal('fetch', fetcher);
    const connection = drive.useGoogleDriveSession(session());
    const download = drive.downloadDriveImage('private-image', owner);
    const upload = drive.uploadDriveImage('new-image', owner, new Blob(['image'], { type: 'image/png' }));
    await Promise.resolve(); expect(fetcher).toHaveBeenCalledTimes(1);
    profile.resolve(json({ sub: subject }));
    expect(await connection).toBe(true); expect((await download).size).toBe(5); expect(await upload).toBe('uploaded-image');
  });
  it('blocks both image directions for another Note account before any file request', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => basicFetch(input)); vi.stubGlobal('fetch', fetcher);
    await drive.useGoogleDriveSession(session()); const calls = fetcher.mock.calls.length;
    await expect(drive.downloadDriveImage('private-image', 'note-user-b')).rejects.toThrow('Reconnect');
    await expect(drive.uploadDriveImage('new-image', 'note-user-b', new Blob(['image']))).rejects.toThrow('Reconnect');
    expect(fetcher).toHaveBeenCalledTimes(calls);
  });
  it('renews once for concurrent download 401s without disconnecting successful requests', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ data: lease('first-access'), error: null }).mockResolvedValue({ data: lease('renewed-access'), error: null });
    await drive.useGoogleDriveSession(session(true), clientWith(invoke));
    const release = deferred<void>(); let rejectedRequests = 0;
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (new Headers(init?.headers).get('Authorization') === 'Bearer first-access') {
        if (++rejectedRequests === 2) release.resolve();
        await release.promise; return json({}, 401);
      }
      return new Response(new Blob(['image']));
    }));
    const generation = manager.driveGeneration();
    const downloaded = await Promise.all([drive.downloadDriveImage('first-image', owner), drive.downloadDriveImage('second-image', owner)]);
    expect(downloaded.map(blob => blob.size)).toEqual([5, 5]); expect(rejectedRequests).toBe(2);
    expect(invoke).toHaveBeenCalledTimes(2); expect(manager.driveGeneration()).toBe(generation); expect(drive.driveConnected(owner)).toBe(true);
  });
  it('replays an unauthorized upload once with the renewed access token and original file', async () => {
    const invoke = vi.fn().mockResolvedValueOnce({ data: lease('first-access'), error: null }).mockResolvedValue({ data: lease('renewed-access'), error: null });
    await drive.useGoogleDriveSession(session(true), clientWith(invoke));
    const uploadedBodies: FormData[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (inputUrl(input).pathname === '/upload/drive/v3/files') {
        uploadedBodies.push(init!.body as FormData);
        return new Headers(init?.headers).get('Authorization') === 'Bearer first-access' ? json({}, 401) : json({ id: 'uploaded-after-renewal' });
      }
      return basicFetch(input);
    }));
    expect(await drive.uploadDriveImage('new-image', owner, new Blob(['original-image'], { type: 'image/png' }))).toBe('uploaded-after-renewal');
    expect(uploadedBodies).toHaveLength(2); expect(uploadedBodies[0]).toBe(uploadedBodies[1]);
    expect(await (uploadedBodies[1].get('file') as Blob).text()).toBe('original-image'); expect(invoke).toHaveBeenCalledTimes(2);
  });
  it('shares the image-folder lookup for simultaneous uploads', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => basicFetch(input)); vi.stubGlobal('fetch', fetcher);
    await drive.useGoogleDriveSession(session());
    expect(await Promise.all([drive.uploadDriveImage('one', owner, new Blob(['one'])), drive.uploadDriveImage('two', owner, new Blob(['two']))])).toEqual(['uploaded-image', 'uploaded-image']);
    const folderQueries = fetcher.mock.calls.filter(([input]) => inputUrl(input).searchParams.get('q')?.includes('mimeType='));
    expect(folderQueries).toHaveLength(1);
  });
  it.each([
    [403, 'storageQuotaExceeded', 'full'],
    [403, 'rateLimitExceeded', 'limiting'],
    [403, 'insufficientFilePermissions', 'permissions'],
    [404, '', 'not found'],
    [429, '', 'limiting'],
    [503, '', 'temporarily unavailable'],
  ] as const)('explains file error %s / %s without discarding working authorization', async (status, reason, message) => {
    const invoke = vi.fn().mockResolvedValue({ data: lease('working-access'), error: null });
    await drive.useGoogleDriveSession(session(true), clientWith(invoke));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(json({ error: { errors: [{ reason }] } }, status)));
    await expect(drive.downloadDriveImage('private-image', owner)).rejects.toThrow(message);
    expect(drive.driveConnected(owner)).toBe(true); expect(drive.getDriveStatus().phase).not.toBe('reconnect'); expect(invoke).toHaveBeenCalledTimes(1);
  });
  it('does not return a downloaded body after the active account changes', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => basicFetch(input))); await drive.useGoogleDriveSession(session());
    const body = deferred<Blob>(), started = deferred<void>(); const response = new Response('image');
    Object.defineProperty(response, 'blob', { value: () => { started.resolve(); return body.promise; } });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    const downloaded = drive.downloadDriveImage('private-image', owner); await started.promise;
    drive.disconnectDrive(); body.resolve(new Blob(['image']));
    await expect(downloaded).rejects.toThrow('account changed'); expect(drive.driveConnected()).toBe(false);
  });
  it('does not acknowledge an upload whose response finishes after sign-out', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => basicFetch(input))); await drive.useGoogleDriveSession(session());
    const body = deferred<{ id: string }>(), started = deferred<void>(); const response = json({ id: 'late-upload' });
    Object.defineProperty(response, 'json', { value: () => { started.resolve(); return body.promise; } });
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => inputUrl(input).pathname === '/upload/drive/v3/files' ? response : basicFetch(input)));
    const uploaded = drive.uploadDriveImage('new-image', owner, new Blob(['image'])); await started.promise;
    drive.disconnectDrive(); body.resolve({ id: 'late-upload' });
    await expect(uploaded).rejects.toThrow('account changed');
  });
  it('honors cancellation without starting an image request or disconnecting Drive', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => basicFetch(input)); vi.stubGlobal('fetch', fetcher); await drive.useGoogleDriveSession(session());
    const calls = fetcher.mock.calls.length, controller = new AbortController(); controller.abort(new Error('Image no longer needed'));
    await expect(drive.downloadDriveImage('private-image', owner, controller.signal)).rejects.toThrow('Image no longer needed');
    expect(fetcher).toHaveBeenCalledTimes(calls); expect(drive.driveConnected(owner)).toBe(true);
  });
});
