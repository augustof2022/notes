import { decryptTokens, encryptTokens, type DriveTokens } from './crypto.ts';

export interface CredentialRow {
  owner_id: string; google_subject: string; version: string; encrypted_payload: string; updated_at: string;
}
export interface CredentialStore {
  read(owner: string): Promise<CredentialRow | null>;
  insert(row: CredentialRow): Promise<boolean>;
  replace(row: CredentialRow, expectedVersion: string): Promise<boolean>;
}
export interface AuthUser { id: string; role?: string; identities?: { provider?: string; identity_data?: Record<string, unknown> }[] }
export interface DriveSessionDependencies {
  authenticate(jwt: string): Promise<AuthUser | null>;
  store: CredentialStore;
  key: CryptoKey;
  clientId: string; clientSecret: string; allowedOrigins: string[];
  fetcher?: typeof fetch; now?: () => number;
}
export class DriveSessionError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
const transient = () => new DriveSessionError(503, 'drive_temporarily_unavailable', 'Google Drive is temporarily unavailable. Retry in a moment.');
const reconnect = () => new DriveSessionError(409, 'drive_reconnect_required', 'Reconnect Google Drive to continue.');
const setup = () => new DriveSessionError(503, 'drive_setup_required', 'The app owner needs to finish the one-time Google Drive refresh setup.');
const permission = () => new DriveSessionError(403, 'drive_permission_required', 'Reconnect Google Drive and allow access to files created by Note.');
class InvalidGrant extends Error {}
const driveScope = 'https://www.googleapis.com/auth/drive.file';
const emptyTokens: DriveTokens = { refresh_token: '', access_token: '', expires_at: 0 };
function rateLimited(data: Record<string, unknown>) {
  const error = data.error as { status?: string; errors?: { reason?: string }[] } | undefined;
  return error?.status === 'RESOURCE_EXHAUSTED' || error?.errors?.some(item => /rateLimit|quota|dailyLimit/i.test(item.reason || ''));
}
const tokenLimit = 8192;
function token(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= tokenLimit && !/[\r\n]/.test(value); }
function isSetupError(error: unknown) {
  const value = error as { code?: string; message?: string } | null;
  return ['42P01', '42501', 'PGRST205', 'PGRST301'].includes(value?.code || '')
    || /note_drive_credentials|encryption key/i.test(value?.message || '');
}
function subjectFor(user: AuthUser) {
  const identity = user.identities?.find(item => item.provider === 'google');
  const subject = identity?.identity_data?.sub;
  if (typeof subject !== 'string' || !subject || subject.length > 255) throw new DriveSessionError(403, 'drive_account_mismatch', 'Use the Google account linked to this Note account to reconnect Drive.');
  return subject;
}
function session(tokens: DriveTokens, subject: string) {
  return { access_token: tokens.access_token, expires_at: tokens.expires_at, google_subject: subject, renewable: true };
}
/** Only the caller's verified Supabase identity chooses a row. No request owner ID is used. */
export function createDriveSessionHandler(deps: DriveSessionDependencies) {
  const fetcher = deps.fetcher || fetch, now = deps.now || Date.now;
  const renewing = new Map<string, Promise<ReturnType<typeof session>>>();
  const origins = new Set(deps.allowedOrigins.filter(value => value && value !== '*'));
  async function googleFetch(url: string, init: RequestInit) {
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetcher(url, { ...init, signal: controller.signal, redirect: 'error' });
      // Keep the timeout active through body consumption, not only headers.
      const data = await response.json() as Record<string, unknown>;
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw transient();
      return { ok: response.ok, status: response.status, data };
    } catch { throw transient(); }
    finally { clearTimeout(timeout); }
  }
  async function exchange(refresh: string, subject: string): Promise<DriveTokens> {
    const response = await googleFetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: deps.clientId, client_secret: deps.clientSecret, refresh_token: refresh, grant_type: 'refresh_token' })
    });
    const data = response.data;
    if (!response.ok) {
      if (data.error === 'invalid_grant') throw new InvalidGrant();
      if (['invalid_client', 'unauthorized_client', 'invalid_request'].includes(String(data.error))) throw setup();
      throw transient();
    }
    if (!token(data.access_token) || typeof data.expires_in !== 'number' || !Number.isFinite(data.expires_in) || data.expires_in <= 0 || data.expires_in > 65 * 60) throw transient();
    if (typeof data.scope === 'string' && !data.scope.split(/\s+/).includes(driveScope)) throw permission();
    const expiresAt = now() + data.expires_in * 1000;
    const headers = { Authorization: `Bearer ${data.access_token}` };
    const profile = await googleFetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers });
    if (!profile.ok) {
      if (profile.status === 401) throw reconnect();
      if (profile.status === 403 && !rateLimited(profile.data)) throw permission();
      throw transient();
    }
    if (profile.data.sub !== subject) throw new DriveSessionError(403, 'drive_account_mismatch', 'Reconnect Drive using the Google account linked to this Note account.');
    const drive = await googleFetch('https://www.googleapis.com/drive/v3/about?fields=user', { headers });
    if (!drive.ok) {
      if (drive.status === 401) throw reconnect();
      if (drive.status === 403 && !rateLimited(drive.data)) throw permission();
      throw transient();
    }
    if (data.refresh_token !== undefined && !token(data.refresh_token)) throw transient();
    return { refresh_token: (data.refresh_token as string | undefined) || refresh, access_token: data.access_token, expires_at: expiresAt };
  }
  async function decode(row: CredentialRow) {
    try { return await decryptTokens(deps.key, row.owner_id, row.google_subject, row.encrypted_payload); }
    catch { throw reconnect(); }
  }
  async function rowFor(owner: string, subject: string, tokens: DriveTokens): Promise<CredentialRow> {
    return { owner_id: owner, google_subject: subject, version: crypto.randomUUID(), encrypted_payload: await encryptTokens(deps.key, owner, subject, tokens), updated_at: new Date(now()).toISOString() };
  }
  async function latestSession(owner: string, subject: string) {
    const row = await deps.store.read(owner);
    if (!row || row.google_subject !== subject) throw reconnect();
    const tokens = await decode(row);
    if (!tokens.refresh_token) throw reconnect();
    if (!tokens.access_token || tokens.expires_at <= now() + 120000 || tokens.expires_at > now() + 65 * 60000) throw transient();
    return session(tokens, subject);
  }
  async function clear(row: CredentialRow) {
    // Retain an inert version marker (no Google tokens), so a connect that was
    // already in flight cannot insert/re-save a grant after a disconnect.
    return deps.store.replace(await rowFor(row.owner_id, row.google_subject, emptyTokens), row.version);
  }
  async function getToken(owner: string, subject: string, rejected: unknown) {
    const row = await deps.store.read(owner);
    if (!row || row.google_subject !== subject) throw reconnect();
    const cached = await decode(row);
    if (!token(cached.refresh_token)) throw reconnect();
    if (token(cached.access_token) && cached.expires_at > now() + 120000 && cached.expires_at <= now() + 65 * 60000 && rejected !== cached.access_token) return session(cached, subject);
    const key = `${owner}:${row.version}`;
    const active = renewing.get(key); if (active) return active;
    const renewal = (async () => {
      let fresh: DriveTokens;
      try { fresh = await exchange(cached.refresh_token, subject); }
      catch (error) {
        if (error instanceof InvalidGrant) {
          if (!await clear(row)) return latestSession(owner, subject);
          throw reconnect();
        }
        throw error;
      }
      if (!await deps.store.replace(await rowFor(owner, subject, fresh), row.version)) return latestSession(owner, subject);
      return session(fresh, subject);
    })();
    renewing.set(key, renewal);
    try { return await renewal; } finally { if (renewing.get(key) === renewal) renewing.delete(key); }
  }
  return async function handle(request: Request): Promise<Response> {
    const origin = request.headers.get('origin');
    const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private', Pragma: 'no-cache', Vary: 'Origin' });
    if (origin && origins.has(origin)) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Headers', 'authorization, apikey, content-type, x-client-info, x-supabase-api-version');
      headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
      headers.set('Access-Control-Max-Age', '600');
    }
    const reply = (status: number, data: unknown) => new Response(JSON.stringify(data), { status, headers });
    if (origin && !origins.has(origin)) return reply(403, { error: 'origin_not_allowed', message: 'This app origin is not allowed.' });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
    if (request.method !== 'POST') return reply(405, { error: 'method_not_allowed', message: 'Use POST for this request.' });
    try {
      const authorization = request.headers.get('authorization'), jwt = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
      if (!jwt || jwt.length > 16384) throw new DriveSessionError(401, 'unauthorized', 'Sign in to Note again.');
      let user: AuthUser | null;
      try { user = await deps.authenticate(jwt); } catch (error) { throw error instanceof DriveSessionError ? error : transient(); }
      if (!user?.id || user.role !== 'authenticated') throw new DriveSessionError(401, 'unauthorized', 'Sign in to Note again.');
      if (!deps.clientId || !deps.clientSecret || !origins.size) throw setup();
      const contentLength = Number(request.headers.get('content-length'));
      if (contentLength > 16384) throw new DriveSessionError(413, 'request_too_large', 'This request is too large.');
      if (!request.headers.get('content-type')?.toLowerCase().includes('application/json')) throw new DriveSessionError(415, 'invalid_request', 'Use a JSON request.');
      const reader = request.body?.getReader();
      let raw = '', received = 0;
      const decoder = new TextDecoder();
      if (reader) {
        try {
          for (;;) {
            const chunk = await reader.read(); if (chunk.done) break;
            received += chunk.value.byteLength;
            if (received > 16384) { await reader.cancel(); throw new DriveSessionError(413, 'request_too_large', 'This request is too large.'); }
            raw += decoder.decode(chunk.value, { stream: true });
          }
          raw += decoder.decode();
        } finally { reader.releaseLock(); }
      }
      let body: Record<string, unknown>;
      try { body = JSON.parse(raw); } catch { throw new DriveSessionError(400, 'invalid_request', 'The request is not valid JSON.'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new DriveSessionError(400, 'invalid_request', 'The request is not valid JSON.');
      if (body.action === 'disconnect') {
        const row = await deps.store.read(user.id);
        const subject = row?.google_subject || subjectFor(user);
        const marker = await rowFor(user.id, subject, emptyTokens);
        if (row ? !await deps.store.replace(marker, row.version) : !await deps.store.insert(marker)) throw transient();
        return reply(200, { disconnected: true });
      }
      const subject = subjectFor(user);
      if (body.action === 'connect') {
        if (!token(body.provider_refresh_token)) throw new DriveSessionError(400, 'invalid_request', 'A Google refresh grant is needed. Reconnect Google Drive.');
        const previous = await deps.store.read(user.id);
        let tokens: DriveTokens;
        try { tokens = await exchange(body.provider_refresh_token, subject); } catch (error) { if (error instanceof InvalidGrant) throw reconnect(); throw error; }
        const row = await rowFor(user.id, subject, tokens);
        const saved = previous ? await deps.store.replace(row, previous.version) : await deps.store.insert(row);
        return reply(200, saved ? session(tokens, subject) : await latestSession(user.id, subject));
      }
      if (body.action === 'token') {
        if (body.rejected_token !== undefined && !token(body.rejected_token)) throw new DriveSessionError(400, 'invalid_request', 'The rejected access token is invalid.');
        return reply(200, await getToken(user.id, subject, body.rejected_token));
      }
      throw new DriveSessionError(400, 'invalid_request', 'Unknown Drive session action.');
    } catch (error) {
      const problem = error instanceof DriveSessionError ? error : isSetupError(error) ? setup() : transient();
      return reply(problem.status, { error: problem.code, message: problem.message });
    }
  };
}
