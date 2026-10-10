type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

// Keep the Note session across reloads, but keep Google credentials in memory.
export function createAuthStorage(storage: StorageLike) {
  const providers = new Map<string, { owner: string; token: string }>();
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
      if (provider && provider.owner === session.user?.id) session.provider_token = provider.token;
      return JSON.stringify(session);
    },
    setItem(key: string, value: string) {
      const session = unpack(value);
      if (!session) { storage.setItem(key, value); return; }
      const owner = session.user?.id;
      if (typeof session.provider_token === 'string' && owner) providers.set(key, { owner, token: session.provider_token });
      else if (providers.get(key)?.owner !== owner) providers.delete(key);
      delete session.provider_token; delete session.provider_refresh_token;
      storage.setItem(key, JSON.stringify(session));
    },
    removeItem(key: string) { providers.delete(key); storage.removeItem(key); }
  };
}
