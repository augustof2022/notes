import type { Session, SupabaseClient } from '@supabase/supabase-js';

export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
let accessToken = ''; let expiresAt = 0; let folderId = ''; let ownerId = '';
let checking = ''; let checkingOwner = ''; let generation = 0;
export function driveConnected(owner?: string) { return !!accessToken && Date.now() < expiresAt && (!owner || owner === ownerId); }
export function disconnectDrive() { accessToken = ''; expiresAt = 0; folderId = ''; ownerId = ''; checking = ''; checkingOwner = ''; generation++; }

export async function googleSignInUrl(client: SupabaseClient, redirectTo: string, email?: string) {
  const { data, error } = await client.auth.signInWithOAuth({ provider: 'google', options: {
    redirectTo, scopes: DRIVE_SCOPE, skipBrowserRedirect: true,
    queryParams: { prompt: 'select_account', include_granted_scopes: 'true', ...(email ? { login_hint: email } : {}) }
  } });
  if (error) throw error;
  if (!data.url) throw new Error('Google sign-in is unavailable. The app owner needs to enable Google in Supabase.');
  return data.url;
}

export async function useGoogleDriveSession(session: Session | null): Promise<boolean> {
  if (!session || (session.user.id !== ownerId && session.user.id !== checkingOwner)) disconnectDrive();
  if (!session?.provider_token) return driveConnected(session?.user.id);
  const identity = session.user.identities?.find(identity => identity.provider === 'google');
  const subject = identity?.identity_data?.sub || identity?.id;
  if (!subject) return false;
  const token = session.provider_token;
  if (token === accessToken || token === checking) return driveConnected(session.user.id);
  disconnectDrive(); checking = token; checkingOwner = session.user.id; const checkGeneration = generation;
  try {
    const headers = { Authorization: `Bearer ${token}` };
    const profile = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', { headers });
    if (!profile.ok || (await profile.json()).sub !== subject) throw new Error('Reconnect Drive using the Google account you used to sign in to Note.');
    const permission = await fetch('https://www.googleapis.com/drive/v3/about?fields=user', { headers });
    if (!permission.ok) throw new Error('Google Drive permission is needed to sync images. Reconnect Drive and allow access to files created by Note.');
    if (generation !== checkGeneration) return false;
    accessToken = token; ownerId = session.user.id; folderId = '';
    // Supabase refreshes its own session, not Google's token. Reconnect early.
    expiresAt = Date.now() + 50 * 60 * 1000;
    return true;
  } catch (error) {
    if (generation !== checkGeneration) return false;
    throw error;
  } finally { if (checking === token) { checking = ''; checkingOwner = ''; } }
}

async function driveFetch(path: string, owner: string, init?: RequestInit) {
  if (!driveConnected(owner)) throw new Error('Reconnect Google Drive to sync your images. Your local copy is safe.');
  const requestGeneration = generation;
  const headers = new Headers(init?.headers); headers.set('Authorization', `Bearer ${accessToken}`);
  const response = await fetch(`https://www.googleapis.com/${path}`, { ...init, headers });
  if (requestGeneration !== generation || owner !== ownerId) throw new Error('The Drive account changed. Retry in the current workspace.');
  if (!response.ok) {
    if (response.status === 401) disconnectDrive();
    throw new Error(response.status === 401 ? 'Reconnect Google Drive to continue.' : `Google Drive returned ${response.status}. Check storage space and access.`);
  }
  return response;
}
async function ensureImageFolder(owner: string) {
  if (!driveConnected(owner)) throw new Error('Reconnect Google Drive to sync your images.');
  if (folderId) return folderId;
  const query = "mimeType='application/vnd.google-apps.folder' and trashed=false and appProperties has { key='noteCanvas' and value='images' }";
  const response = await driveFetch(`drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`, owner);
  const existing = await response.json();
  if (existing.files?.[0]) {
    if (!driveConnected(owner)) throw new Error('The Drive account changed. Reconnect to continue.');
    folderId = existing.files[0].id; return folderId;
  }
  const created = await driveFetch('drive/v3/files?fields=id', owner, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Note images', mimeType: 'application/vnd.google-apps.folder', appProperties: { noteCanvas: 'images' } }) });
  const createdId = (await created.json()).id;
  if (!driveConnected(owner)) throw new Error('The Drive account changed. Reconnect to continue.');
  folderId = createdId; return folderId;
}
export async function uploadDriveImage(id: string, owner: string, blob: Blob) {
  const parent = await ensureImageFolder(owner);
  // Reuse a completed upload after a network failure before Supabase metadata saved.
  const query = `trashed=false and '${parent}' in parents and appProperties has { key='assetId' and value='${id.replace(/'/g, '')}' } and appProperties has { key='owner' and value='${owner}' }`;
  const lookup = await driveFetch(`drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`, owner);
  const existing = await lookup.json(); if (existing.files?.[0]) return existing.files[0].id as string;
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ name: `note-${id}.${blob.type.includes('webp') ? 'webp' : 'png'}`, parents: [parent], appProperties: { assetId: id, owner } })], { type: 'application/json' }));
  form.append('file', blob);
  const response = await driveFetch('upload/drive/v3/files?uploadType=multipart&fields=id', owner, { method: 'POST', body: form });
  return (await response.json()).id as string;
}
export async function downloadDriveImage(id: string, owner: string) { return (await driveFetch(`drive/v3/files/${encodeURIComponent(id)}?alt=media`, owner)).blob(); }
