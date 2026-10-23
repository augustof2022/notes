type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

// Keep the Note session across reloads, but keep Google credentials in memory.
export function createAuthStorage(storage: StorageLike) {
  const providers = new Map<string, { owner: string; token?: string; refreshToken?: string }>();
  function unpack(value: string) {
    try { const parsed = JSON.parse(value); return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null; }
    catch { return null; }
  }
  return {
    getItem(key: string) {
      const value = storage.getItem(key); if (!value) return value;
      const session = unpack(value); if (!session) return value;
      delete session.provider_token; delete session.provider_refresh_token;
      const provider = providers.get(key);
      if (provider && provider.owner === session.user?.id) {
        if (provider.token) session.provider_token = provider.token;
        if (provider.refreshToken) session.provider_refresh_token = provider.refreshToken;
      }
      return JSON.stringify(session);
    },
    setItem(key: string, value: string) {
      const session = unpack(value);
      if (!session) { storage.setItem(key, value); return; }
      const owner = session.user?.id;
      const previous = providers.get(key);
      if (typeof owner === 'string' && owner) {
        const credentials = previous?.owner === owner ? previous : { owner };
        if (typeof session.provider_token === 'string' && session.provider_token) credentials.token = session.provider_token;
        if (typeof session.provider_refresh_token === 'string' && session.provider_refresh_token) credentials.refreshToken = session.provider_refresh_token;
        if (credentials.token || credentials.refreshToken) providers.set(key, credentials);
        else providers.delete(key);
      } else providers.delete(key);
      delete session.provider_token; delete session.provider_refresh_token;
      storage.setItem(key, JSON.stringify(session));
    },
    removeItem(key: string) { providers.delete(key); storage.removeItem(key); }
  };
}
