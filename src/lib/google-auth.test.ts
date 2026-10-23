import { describe, expect, it } from 'vitest';
import { createAuthStorage } from './auth-storage';

function memoryStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); }, removeItem: (key: string) => { values.delete(key); } };
}
describe('Google credential storage', () => {
  it('keeps Google tokens in memory while persisting only the Note login', () => {
    const disk = memoryStorage(), storage = createAuthStorage(disk);
    storage.setItem('auth', JSON.stringify({ user: { id: 'a' }, access_token: 'note-session', refresh_token: 'note-refresh', provider_token: 'google-session', provider_refresh_token: 'google-refresh' }));
    expect(disk.getItem('auth')).not.toContain('google-session');
    expect(disk.getItem('auth')).not.toContain('google-refresh');
    expect(JSON.parse(storage.getItem('auth')!).provider_token).toBe('google-session');
    expect(JSON.parse(storage.getItem('auth')!).provider_refresh_token).toBe('google-refresh');
    expect(JSON.parse(createAuthStorage(disk).getItem('auth')!).provider_token).toBeUndefined();
    expect(JSON.parse(createAuthStorage(disk).getItem('auth')!).provider_refresh_token).toBeUndefined();
    expect(JSON.parse(disk.getItem('auth')!).refresh_token).toBe('note-refresh');
  });
  it('drops provider credentials when the Note account changes or signs out', () => {
    const storage = createAuthStorage(memoryStorage());
    storage.setItem('auth', JSON.stringify({ user: { id: 'a' }, provider_token: 'google-a' }));
    storage.setItem('auth', JSON.stringify({ user: { id: 'b' } }));
    expect(JSON.parse(storage.getItem('auth')!).provider_token).toBeUndefined();
    storage.setItem('verifier', JSON.stringify('pkce-verifier'));
    expect(storage.getItem('verifier')).toBe(JSON.stringify('pkce-verifier'));
    storage.removeItem('auth'); expect(storage.getItem('auth')).toBeNull();
  });
  it('retains and rotates provider credentials only in memory across Note session refreshes', () => {
    const disk = memoryStorage(), storage = createAuthStorage(disk);
    storage.setItem('auth', JSON.stringify({ user: { id: 'a' }, provider_token: 'google-a', provider_refresh_token: 'refresh-a' }));
    storage.setItem('auth', JSON.stringify({ user: { id: 'a' }, access_token: 'new-note-session' }));
    expect(JSON.parse(storage.getItem('auth')!)).toMatchObject({ provider_token: 'google-a', provider_refresh_token: 'refresh-a', access_token: 'new-note-session' });
    storage.setItem('auth', JSON.stringify({ user: { id: 'a' }, provider_refresh_token: 'rotated-refresh' }));
    expect(JSON.parse(storage.getItem('auth')!)).toMatchObject({ provider_token: 'google-a', provider_refresh_token: 'rotated-refresh' });
    expect(disk.getItem('auth')).not.toMatch(/google-a|refresh-a|rotated-refresh|provider_/);
    storage.setItem('auth', JSON.stringify({ user: { id: 'b' } }));
    expect(JSON.parse(storage.getItem('auth')!).provider_refresh_token).toBeUndefined();
    storage.setItem('auth', JSON.stringify({ user: { id: 'b' }, provider_refresh_token: 'refresh-b' }));
    storage.removeItem('auth');
    storage.setItem('auth', JSON.stringify({ user: { id: 'b' } }));
    expect(JSON.parse(storage.getItem('auth')!).provider_refresh_token).toBeUndefined();
  });
});
