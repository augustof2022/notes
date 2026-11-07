import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * A Gemini API key encrypted in the browser with a passphrase that never
 * leaves the device. Only this ciphertext is stored in the account; the
 * database, the server, and the app operator cannot read the key.
 */
export interface SealedAiKey { ciphertext: string; iv: string; salt: string; iterations: number }
export const AI_KEY_ITERATIONS = 600_000;
const encoder = new TextEncoder(), decoder = new TextDecoder();

const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string) => Uint8Array.from(atob(text), character => character.charCodeAt(0));

export async function deriveAiKeyLock(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
  const material = await crypto.subtle.importKey('raw', encoder.encode(passphrase.normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  // Not extractable: a remembered device key can decrypt, but cannot be exported.
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt: salt as BufferSource, iterations, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function sealAiKey(apiKey: string, passphrase: string, iterations = AI_KEY_ITERATIONS): Promise<{ sealed: SealedAiKey; lock: CryptoKey }> {
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const lock = await deriveAiKeyLock(passphrase, salt, iterations);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, lock, encoder.encode(apiKey.trim())));
  return { sealed: { ciphertext: toBase64(ciphertext), iv: toBase64(iv), salt: toBase64(salt), iterations }, lock };
}

export class WrongPassphraseError extends Error { constructor() { super('That passphrase does not unlock your saved key.'); } }

export async function openAiKey(sealed: SealedAiKey, lock: CryptoKey): Promise<string> {
  try {
    return decoder.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(sealed.iv) as BufferSource }, lock, fromBase64(sealed.ciphertext) as BufferSource));
  } catch { throw new WrongPassphraseError(); }
}

export async function unlockAiKey(sealed: SealedAiKey, passphrase: string) {
  const lock = await deriveAiKeyLock(passphrase, fromBase64(sealed.salt), sealed.iterations);
  return { apiKey: await openAiKey(sealed, lock), lock };
}

export const looksLikeGeminiKey = (value: string) => /^[A-Za-z0-9_-]{30,80}$/.test(value.trim());

// --- Account storage (ciphertext only) -------------------------------------

export async function loadSealedAiKey(client: SupabaseClient): Promise<SealedAiKey | null> {
  const { data, error } = await client.from('note_ai_keys').select('ciphertext, iv, salt, iterations').maybeSingle();
  if (error) throw new Error(error.code === '42P01' || /note_ai_keys/.test(error.message) ? 'Ask AI is not set up in this Note database yet. The app owner needs to run enable-ask-ai.sql.' : error.message);
  return data as SealedAiKey | null;
}
export async function saveSealedAiKey(client: SupabaseClient, sealed: SealedAiKey) {
  const { error } = await client.from('note_ai_keys').upsert({ ...sealed, provider: 'gemini', updated_at: new Date().toISOString() }, { onConflict: 'owner_id' });
  if (error) throw new Error(error.message);
}
export async function deleteSealedAiKey(client: SupabaseClient, owner: string) {
  const { error } = await client.from('note_ai_keys').delete().eq('owner_id', owner);
  if (error) throw new Error(error.message);
}

// --- Remembered on this device ---------------------------------------------
// The derived lock (not the passphrase or the API key) is kept per account in
// this browser's IndexedDB so the passphrase is needed once per device.

const DEVICE_DB = 'note-ai-device', STORE = 'locks';
function deviceDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DEVICE_DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
}
async function deviceStore<T>(mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await deviceDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const request = run(database.transaction(STORE, mode).objectStore(STORE));
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
  } finally { database.close(); }
}
export interface RememberedLock { lock: CryptoKey; salt: string }
export const rememberAiKeyLock = (owner: string, value: RememberedLock) => deviceStore('readwrite', store => store.put(value, owner)).catch(() => undefined);
export const rememberedAiKeyLock = (owner: string) => deviceStore<RememberedLock | undefined>('readonly', store => store.get(owner)).catch(() => undefined);
export const forgetAiKeyLock = (owner: string) => deviceStore('readwrite', store => store.delete(owner)).catch(() => undefined);
