export interface DriveAccessLease { owner: string; subject: string; token: string; expiresAt: number; renewable: boolean }
export type DriveStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export function browserDriveStorage(): DriveStorage | undefined {
  try { return typeof localStorage === 'undefined' ? undefined : localStorage; } catch { return undefined; }
}
export function readDriveLease(key: string, owner: string, subject: string, storage = browserDriveStorage(), now = Date.now()): DriveAccessLease | null {
  try {
    const lease = JSON.parse(storage?.getItem(key) || 'null') as DriveAccessLease | null;
    if (lease && lease.owner === owner && lease.subject === subject && typeof lease.token === 'string' && lease.token.length > 0 && lease.token.length <= 8192
      && typeof lease.renewable === 'boolean'
      && Number.isFinite(lease.expiresAt) && lease.expiresAt > now && lease.expiresAt <= now + 65 * 60 * 1000) return lease;
    storage?.removeItem(key);
  } catch { /* A private/cleared browser can still use the current connection. */ }
  return null;
}
export function writeDriveLease(key: string, lease: DriveAccessLease, storage = browserDriveStorage()) {
  try { storage?.setItem(key, JSON.stringify(lease)); } catch { /* Persistence is optional; server renewal remains available. */ }
}
export function clearDriveLease(key: string, storage = browserDriveStorage()) { try { storage?.removeItem(key); } catch { /* Already unavailable. */ } }
