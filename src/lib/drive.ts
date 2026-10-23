import { cloudFetch } from './request-timeout';
import { driveAccessRejected, driveGeneration, ensureDriveAccess } from './drive-auth';
export { disconnectDrive, DRIVE_SCOPE, driveConnected, getDriveStatus, googleSignInUrl, onDriveStatus, useGoogleDriveSession, ensureDriveAccess } from './drive-auth';
export type { DriveStatus } from './drive-auth';

let folder: { owner: string; generation: number; promise: Promise<string> } | null = null;
class DriveRequestError extends Error {
  constructor(public status: number, message: string) { super(message); }
}
function assertGeneration(version: number) {
  if (version !== driveGeneration()) throw new Error('The Drive account changed. Retry in the current workspace.');
}
async function requestError(response: Response) {
  let reason = '';
  try { reason = (await response.clone().json()).error?.errors?.[0]?.reason || ''; } catch { /* Never expose raw Google errors or request credentials. */ }
  const message = /storageQuotaExceeded/i.test(reason) ? 'Google Drive is full. Free some space, then sync again.'
    : response.status === 429 || /rateLimit|quota/i.test(reason) ? 'Google Drive is limiting requests. Wait a moment, then retry images.'
    : response.status >= 500 ? 'Google Drive is temporarily unavailable. Retry images in a moment.'
    : response.status === 404 ? 'This image was not found in Google Drive. Check that it still exists in the original Google account.'
    : response.status === 403 ? 'Google Drive denied access to this file. Check its permissions and that you are using the Google account that owns it.'
    : `Google Drive returned ${response.status}. Retry images in a moment.`;
  return new DriveRequestError(response.status, message);
}
async function driveFetch(path: string, owner: string, init?: RequestInit) {
  let access = await ensureDriveAccess(owner);
  const send = async () => {
    if (init?.signal?.aborted) throw init.signal.reason || new DOMException('Aborted', 'AbortError');
    const headers = new Headers(init?.headers); headers.set('Authorization', `Bearer ${access.token}`);
    const response = await cloudFetch(`https://www.googleapis.com/${path}`, { ...init, headers });
    assertGeneration(access.generation); return response;
  };
  let response = await send();
  if (response.status === 401) {
    // Both image directions share a single renewal, then replay only once.
    access = await ensureDriveAccess(owner, access.token);
    response = await send();
    if (response.status === 401) throw driveAccessRejected(owner, access.token);
  }
  if (!response.ok) throw await requestError(response);
  return response;
}
async function ensureImageFolder(owner: string) {
  const access = await ensureDriveAccess(owner), version = access.generation;
  if (folder?.owner === owner && folder.generation === version) return folder.promise;
  const promise = (async () => {
    const query = "mimeType='application/vnd.google-apps.folder' and trashed=false and appProperties has { key='noteCanvas' and value='images' }";
    const response = await driveFetch(`drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`, owner);
    const existing = await response.json(); assertGeneration(version);
    if (existing.files?.[0]?.id) return existing.files[0].id as string;
    const created = await driveFetch('drive/v3/files?fields=id', owner, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Note images', mimeType: 'application/vnd.google-apps.folder', appProperties: { noteCanvas: 'images' } }) });
    const createdId = (await created.json()).id; assertGeneration(version);
    if (typeof createdId !== 'string' || !createdId) throw new Error('Google Drive did not return an image folder. Retry sync.');
    return createdId;
  })();
  folder = { owner, generation: version, promise };
  try { return await promise; }
  catch (error) { if (folder?.promise === promise) folder = null; throw error; }
}
export async function uploadDriveImage(id: string, owner: string, blob: Blob) {
  const version = driveGeneration();
  const parent = await ensureImageFolder(owner);
  assertGeneration(version);
  // Reuse a completed upload after a network failure before Supabase metadata saved.
  const query = `trashed=false and '${parent}' in parents and appProperties has { key='assetId' and value='${id.replace(/'/g, '')}' } and appProperties has { key='owner' and value='${owner}' }`;
  const lookup = await driveFetch(`drive/v3/files?q=${encodeURIComponent(query)}&fields=files(id)&pageSize=1`, owner);
  const existing = await lookup.json(); assertGeneration(version);
  if (existing.files?.[0]) return existing.files[0].id as string;
  const form = new FormData();
  form.append('metadata', new Blob([JSON.stringify({ name: `note-${id}.${blob.type.includes('webp') ? 'webp' : 'png'}`, parents: [parent], appProperties: { assetId: id, owner } })], { type: 'application/json' }));
  form.append('file', blob);
  const response = await driveFetch('upload/drive/v3/files?uploadType=multipart&fields=id', owner, { method: 'POST', body: form });
  const uploadedId = (await response.json()).id as string; assertGeneration(version);
  return uploadedId;
}
export async function downloadDriveImage(id: string, owner: string, signal?: AbortSignal) {
  const version = driveGeneration();
  const blob = await (await driveFetch(`drive/v3/files/${encodeURIComponent(id)}?alt=media`, owner, { signal })).blob();
  assertGeneration(version); return blob;
}
