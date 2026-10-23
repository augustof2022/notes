export interface DriveTokens { refresh_token: string; access_token: string; expires_at: number }
const encoder = new TextEncoder();
function base64(bytes: Uint8Array) {
  let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}
function bytes(value: string) {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Invalid encrypted credential.');
  const binary = atob(value); return Uint8Array.from(binary, char => char.charCodeAt(0));
}
/** The key is an Edge Function secret, never a frontend variable or database column. */
export async function importTokenKey(encoded: string) {
  const raw = bytes(encoded);
  if (raw.length !== 32) throw new Error('A 32-byte encryption key is required.');
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
function associatedData(owner: string, subject: string) {
  return encoder.encode(JSON.stringify(['note-drive-v1', owner, subject]));
}
export async function encryptTokens(key: CryptoKey, owner: string, subject: string, tokens: DriveTokens) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: associatedData(owner, subject) }, key, encoder.encode(JSON.stringify(tokens)));
  return `v1.${base64(iv)}.${base64(new Uint8Array(encrypted))}`;
}
export async function decryptTokens(key: CryptoKey, owner: string, subject: string, envelope: string): Promise<DriveTokens> {
  const [version, iv, ciphertext, extra] = envelope.split('.');
  if (version !== 'v1' || !iv || !ciphertext || extra || bytes(iv).length !== 12) throw new Error('Invalid encrypted credential.');
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(iv), additionalData: associatedData(owner, subject) }, key, bytes(ciphertext));
  const value = JSON.parse(new TextDecoder().decode(decrypted));
  if (!value || typeof value.refresh_token !== 'string' || typeof value.access_token !== 'string' || !Number.isFinite(value.expires_at)) throw new Error('Invalid encrypted credential.');
  return value;
}
