import type { Session, SupabaseClient } from '@supabase/supabase-js';
import { appConfig } from '../config';
import { cloudFetch } from './request-timeout';
import { clearDriveLease, readDriveLease, writeDriveLease, type DriveAccessLease } from './drive-cache';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
const cacheKey = `note-drive-access-v1:${appConfig.supabaseUrl}`;
const EARLY_RENEWAL = 2 * 60 * 1000, RETRY_DELAY = 30000;
interface DriveAccount { owner: string; subject: string; client: SupabaseClient | null; providerToken?: string; providerRefresh?: string }
export interface DriveStatus {
  owner?: string; phase: 'disconnected' | 'connecting' | 'connected' | 'renewing' | 'reconnect' | 'temporary';
  renewable: boolean; setupNeeded: boolean; message: string;
}
let account: DriveAccount | null = null, lease: DriveAccessLease | null = null, verified = false, generation = 0;
let initializing: Promise<boolean> | null = null, initKey = '', renewing: Promise<DriveAccessLease> | null = null;
let registeredGrant = '', processedProvider = '', nextAttempt = 0, lastFailure: Error | null = null, setupNeeded = false;
const providerExpiry = new Map<string, number>();
let renewalTimer: ReturnType<typeof setTimeout> | undefined;
let status: DriveStatus = { phase: 'disconnected', renewable: false, setupNeeded: false, message: 'Connect Google Drive to load and upload images.' };
const listeners = new Set<(status: DriveStatus) => void>();
export const getDriveStatus = () => status;
export function onDriveStatus(callback: (status: DriveStatus) => void) { listeners.add(callback); return () => { listeners.delete(callback); }; }
function updateStatus(phase: DriveStatus['phase'], message: string) {
  const next = { owner: account?.owner, phase, renewable: !!lease?.renewable, setupNeeded, message };
  if (JSON.stringify(next) === JSON.stringify(status)) return;
  status = next; for (const callback of listeners) callback(status);
}
export function driveConnected(owner?: string) { return !!lease && verified && lease.expiresAt > Date.now() && (!owner || lease.owner === owner); }
export const driveGeneration = () => generation;
export function disconnectDrive() {
  clearTimeout(renewalTimer); renewalTimer = undefined; clearDriveLease(cacheKey);
  account = null; lease = null; verified = false; initializing = null; initKey = ''; renewing = null;
  registeredGrant = ''; processedProvider = ''; providerExpiry.clear(); nextAttempt = 0; lastFailure = null; setupNeeded = false; generation++;
  updateStatus('disconnected', 'Connect Google Drive to load and upload images.');
}
function assertAccount(owner: string, version = generation) {
  if (generation !== version || account?.owner !== owner) throw new Error('The Drive account changed. Retry in the current workspace.');
}
class DriveSessionError extends Error {
  constructor(message: string, public kind: 'reconnect' | 'setup' | 'temporary' | 'note-auth') { super(message); }
}
const reconnect = () => new DriveSessionError('Reconnect Google Drive to renew access to your images.', 'reconnect');
function currentAccount(owner: string) {
  if (!account || account.owner !== owner || !account.subject) throw reconnect();
  return account;
}
function scheduleRenewal() {
  clearTimeout(renewalTimer); renewalTimer = undefined;
  if (!account || status.phase === 'reconnect') return;
  const retryGrant = !!account.providerRefresh && account.providerRefresh !== registeredGrant && !setupNeeded;
  if (!lease?.renewable && !retryGrant) return;
  const owner = account.owner, version = generation;
  const delay = Math.max(RETRY_DELAY, nextAttempt - Date.now(), retryGrant ? 0 : (lease?.expiresAt || Date.now()) - Date.now() - EARLY_RENEWAL);
  renewalTimer = setTimeout(() => {
    if (generation !== version || account?.owner !== owner) return;
    // Returning to the app or going online calls ensureDriveAccess again.
    if ((typeof navigator !== 'undefined' && navigator.onLine === false) || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
    void ensureDriveAccess(owner).catch(() => {});
  }, delay);
}
function installLease(next: DriveAccessLease, version: number) {
  assertAccount(next.owner, version);
  lease = next; verified = true; nextAttempt = 0; lastFailure = null;
  writeDriveLease(cacheKey, next);
  updateStatus('connected', next.renewable ? 'Drive connected. Access renews automatically.' : setupNeeded
    ? 'Drive connected. Automatic renewal needs the one-time app setup.' : 'Drive connected. This device remembers access until Google expires it.');
  scheduleRenewal(); return next;
}
async function privateSession(body: Record<string, unknown>, owner: string, version: number): Promise<DriveAccessLease> {
  const active = currentAccount(owner), client = active.client;
  if (!client?.functions?.invoke) throw new DriveSessionError('Automatic Drive renewal is not set up for this Note deployment.', 'setup');
  let result = await client.functions.invoke('drive-session', { body });
  assertAccount(owner, version);
  // This 401 is the Note JWT, not Google's authorization. Renew Note once.
  if (result.error?.context instanceof Response && result.error.context.status === 401 && client.auth?.refreshSession) {
    const refreshed = await client.auth.refreshSession(); assertAccount(owner, version);
    if (!refreshed.error) result = await client.functions.invoke('drive-session', { body });
    assertAccount(owner, version);
  }
  const { data, error } = result;
  if (error) {
    let detail: { error?: string; code?: string } = {};
    const response = error.context instanceof Response ? error.context : null;
    if (response) { try { detail = await response.clone().json(); } catch { /* Undeployed functions can return plain 404. */ } }
    const code = (detail.error || detail.code || '').toLowerCase();
    if (response?.status === 404 || code === 'drive_setup_required') throw new DriveSessionError('Automatic Drive renewal needs the one-time app setup.', 'setup');
    if (code === 'drive_reconnect_required' || code === 'drive_account_mismatch' || code === 'drive_permission_required') throw reconnect();
    if (response?.status === 401 || code === 'unauthorized') throw new DriveSessionError('Your Note login needs to refresh. Sync again or sign in to Note.', 'note-auth');
    throw new DriveSessionError('Drive renewal is temporarily unavailable. Images will retry when your connection recovers.', 'temporary');
  }
  if (!data || typeof data.access_token !== 'string' || !data.access_token || data.google_subject !== active.subject
    || !Number.isFinite(data.expires_at) || data.expires_at <= Date.now() || data.expires_at > Date.now() + 65 * 60 * 1000) {
    throw new DriveSessionError('Drive renewal returned an invalid account or access window. Try again.', 'temporary');
  }
  setupNeeded = false;
  return { owner, subject: active.subject, token: data.access_token, expiresAt: data.expires_at, renewable: true };
}
async function verifyProviderToken(token: string, owner: string, subject: string, expiresAt: number, version: number): Promise<DriveAccessLease> {
  const headers = { Authorization: `Bearer ${token}` };
  const profile = await cloudFetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers });
  assertAccount(owner, version);
  if (profile.status === 401) throw reconnect();
  if (!profile.ok) throw new DriveSessionError('Google account verification is temporarily unavailable. Retry images when your connection returns.', 'temporary');
  if ((await profile.json()).sub !== subject) throw new DriveSessionError('Reconnect Drive using the Google account you used to sign in to Note.', 'reconnect');
  const permission = await cloudFetch('https://www.googleapis.com/drive/v3/about?fields=user', { headers });
  assertAccount(owner, version);
  if (permission.status === 401) throw reconnect();
  if (permission.status === 403) {
    let reason = ''; try { reason = (await permission.json()).error?.errors?.[0]?.reason || ''; } catch { /* Redacted fallback. */ }
    if (!/rateLimit|quota/i.test(reason)) throw new DriveSessionError('Google Drive permission is needed. Reconnect Drive and allow access to files created by Note.', 'reconnect');
  }
  if (!permission.ok) throw new DriveSessionError('Google Drive is temporarily unavailable. Retry images in a moment.', 'temporary');
  return { owner, subject, token, expiresAt, renewable: false };
}
function noteFailure(error: unknown, owner: string, version: number) {
  assertAccount(owner, version);
  const problem = error instanceof DriveSessionError ? error : new DriveSessionError('Drive is temporarily unavailable. Check your connection and retry images.', 'temporary');
  lastFailure = problem; nextAttempt = Date.now() + RETRY_DELAY;
  if (problem.kind === 'setup') setupNeeded = true;
  if (problem.kind === 'reconnect') {
    lease = null; verified = false; account!.providerRefresh = undefined; clearDriveLease(cacheKey); clearTimeout(renewalTimer);
    updateStatus('reconnect', problem.message);
  } else if (driveConnected(owner)) {
    updateStatus('connected', setupNeeded ? 'Drive connected. Automatic renewal needs the one-time app setup.' : 'Drive connected. Background renewal will retry after the connection recovers.');
  } else updateStatus('temporary', problem.message);
  scheduleRenewal(); return problem;
}
export async function ensureDriveAccess(owner: string, rejectedToken?: string): Promise<{ token: string; generation: number }> {
  currentAccount(owner); const version = generation;
  if (initializing) await initializing;
  assertAccount(owner, version);
  if (rejectedToken && driveConnected(owner) && lease!.token !== rejectedToken) return { token: lease!.token, generation: version };
  // Only the rejected lease is invalid. Other requests and newer leases survive.
  if (rejectedToken && lease?.token === rejectedToken) { lease = null; verified = false; clearDriveLease(cacheKey); }
  const valid = driveConnected(owner);
  const pendingGrant = !!account?.providerRefresh && account.providerRefresh !== registeredGrant && !setupNeeded && nextAttempt <= Date.now();
  if (!rejectedToken && valid && !pendingGrant && (!lease!.renewable || lease!.expiresAt - Date.now() > EARLY_RENEWAL)) {
    scheduleRenewal(); return { token: lease!.token, generation: version };
  }
  if (renewing) { const next = await renewing; assertAccount(owner, version); return { token: next.token, generation: version }; }
  if (status.phase === 'reconnect') throw reconnect();
  if (nextAttempt > Date.now() && lastFailure) {
    if (!rejectedToken && valid) return { token: lease!.token, generation: version };
    throw lastFailure;
  }
  if (typeof navigator !== 'undefined' && navigator.onLine === false) throw new DriveSessionError('Offline. Drive access will retry when your connection returns.', 'temporary');
  updateStatus(valid ? 'renewing' : 'connecting', 'Renewing Google Drive access…');
  renewing = (async () => {
    try {
      const grant = pendingGrant ? account?.providerRefresh : undefined;
      const next = await privateSession(grant ? { action: 'connect', provider_refresh_token: grant } : { action: 'token', ...(rejectedToken ? { rejected_token: rejectedToken } : {}) }, owner, version);
      assertAccount(owner, version);
      if (grant) registeredGrant = grant;
      return installLease(next, version);
    } catch (error) {
      // A temporary first verification failure must be retryable without a
      // second OAuth flow, even before the renewal service is installed.
      assertAccount(owner, version);
      const pending = account?.providerToken, expiry = pending ? providerExpiry.get(pending) || 0 : 0;
      if (!rejectedToken && pending && pending !== processedProvider && expiry > Date.now()) {
        try {
          const fallback = await verifyProviderToken(pending, owner, account!.subject, expiry, version);
          assertAccount(owner, version); processedProvider = pending;
          if (error instanceof DriveSessionError && error.kind === 'setup') setupNeeded = true;
          installLease(fallback, version);
          if (!(error instanceof DriveSessionError && error.kind === 'reconnect')) noteFailure(error, owner, version);
          return fallback;
        } catch (verificationError) { error = verificationError; }
      }
      const problem = noteFailure(error, owner, version);
      if (!rejectedToken && driveConnected(owner)) return lease!;
      throw problem;
    } finally { if (version === generation) renewing = null; }
  })();
  const next = await renewing; assertAccount(owner, version);
  return { token: next.token, generation: version };
}
export async function useGoogleDriveSession(session: Session | null, client: SupabaseClient | null = null): Promise<boolean> {
  if (!session) { disconnectDrive(); return false; }
  const identity = session.user.identities?.find(identity => identity.provider === 'google');
  const subject = String(identity?.identity_data?.sub || identity?.id || ''), owner = session.user.id;
  if (account && (account.owner !== owner || account.subject !== subject)) disconnectDrive();
  const version = generation;
  account = { owner, subject, client: client || account?.client || null, providerToken: session.provider_token || account?.providerToken, providerRefresh: session.provider_refresh_token || account?.providerRefresh };
  if (!subject) { updateStatus('disconnected', 'Continue with Google to connect Drive to this Note account.'); return false; }
  const token = session.provider_token || '', grant = session.provider_refresh_token || '';
  const key = JSON.stringify([owner, subject, token, grant]);
  if (initializing && initKey === key) return initializing;
  if (initializing) await initializing.catch(() => false);
  if (generation !== version || account?.owner !== owner || account.subject !== subject) return false;
  const newProvider = !!token && token !== processedProvider, newGrant = !!grant && (grant !== registeredGrant || newProvider);
  if (driveConnected(owner) && lease!.renewable && !newGrant) {
    processedProvider = token || processedProvider; scheduleRenewal(); return true;
  }
  if (driveConnected(owner) && !newProvider && !newGrant) { scheduleRenewal(); return true; }
  // A refreshed Note session may repeat the original OAuth token. Never assign
  // that token a fresh expiry or overwrite a newer server-issued access lease.
  if (token && !providerExpiry.has(token)) {
    const cached = readDriveLease(cacheKey, owner, subject);
    providerExpiry.set(token, cached?.token === token ? cached.expiresAt : Date.now() + 50 * 60 * 1000);
  }
  initKey = key; updateStatus('connecting', 'Connecting Google Drive…');
  initializing = (async () => {
    try {
      let serverError: unknown;
      if (account?.client && newGrant) {
        try {
          const next = await privateSession({ action: 'connect', provider_refresh_token: grant }, owner, version);
          assertAccount(owner, version);
          registeredGrant = grant; processedProvider = token || processedProvider;
          installLease(next, version); return true;
        } catch (error) { serverError = error; }
      }
      // Google can omit a refresh token on later logins. Reuse a grant already
      // saved for this Note account before falling back to access-only OAuth.
      if (account?.client && newProvider && !newGrant) {
        try {
          const next = await privateSession({ action: 'token' }, owner, version);
          assertAccount(owner, version); processedProvider = token;
          installLease(next, version); return true;
        } catch (error) { serverError = error; }
      }
      if (newProvider && (providerExpiry.get(token) || 0) > Date.now()) {
        const next = await verifyProviderToken(token, owner, subject, providerExpiry.get(token)!, version);
        assertAccount(owner, version);
        processedProvider = token;
        if (serverError instanceof DriveSessionError && serverError.kind === 'reconnect') {
          // A rejected grant cannot renew this otherwise valid OAuth access.
          registeredGrant = grant; account!.providerRefresh = undefined;
        }
        if (serverError instanceof DriveSessionError && serverError.kind === 'setup') setupNeeded = true;
        installLease(next, version);
        if (serverError) noteFailure(serverError instanceof DriveSessionError && serverError.kind === 'reconnect'
          ? new DriveSessionError('Drive connected. Reconnect once to enable saved access after expiry.', 'temporary') : serverError, owner, version);
        return true;
      }
      if (driveConnected(owner)) return true;
      if (account?.client && !serverError) {
        try { installLease(await privateSession({ action: 'token' }, owner, version), version); return true; }
        catch (error) { serverError = error; }
      }
      const cached = readDriveLease(cacheKey, owner, subject);
      if (cached) {
        const next = await verifyProviderToken(cached.token, owner, subject, cached.expiresAt, version);
        assertAccount(owner, version);
        if (serverError instanceof DriveSessionError && serverError.kind === 'setup') setupNeeded = true;
        installLease({ ...next, renewable: cached.renewable && !setupNeeded && !(serverError instanceof DriveSessionError && serverError.kind === 'reconnect') }, version);
        if (serverError && !(serverError instanceof DriveSessionError && serverError.kind === 'reconnect')) noteFailure(serverError, owner, version);
        return true;
      }
      if (serverError) throw serverError;
      throw reconnect();
    } catch (error) {
      if (version !== generation || account?.owner !== owner) return false;
      const problem = noteFailure(error, owner, version);
      if (driveConnected(owner)) return true;
      throw problem;
    } finally { if (generation === version && initKey === key) { initializing = null; initKey = ''; } }
  })();
  return initializing;
}
export async function googleSignInUrl(client: SupabaseClient, redirectTo: string, email?: string) {
  const { data, error } = await client.auth.signInWithOAuth({ provider: 'google', options: {
    redirectTo, scopes: DRIVE_SCOPE, skipBrowserRedirect: true,
    queryParams: { prompt: 'consent select_account', access_type: 'offline', include_granted_scopes: 'true', ...(email ? { login_hint: email } : {}) }
  } });
  if (error) throw error;
  if (!data.url) throw new Error('Google sign-in is unavailable. The app owner needs to enable Google in Supabase.');
  return data.url;
}
export function driveAccessRejected(owner: string, rejectedToken?: string) {
  const problem = reconnect();
  if (!rejectedToken || !lease || lease.token === rejectedToken) noteFailure(problem, owner, generation);
  return problem;
}
