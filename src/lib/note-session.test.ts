import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthRetryableFetchError, type AuthChangeEvent, type Session, type SupabaseClient } from '@supabase/supabase-js';
import { hasGoogleIdentity, observeNoteSession, type NoteSessionEnvironment, type NoteSessionState } from './note-session';

function session(id = 'note-a', provider = 'google'): Session {
  return { access_token: `access-${id}`, refresh_token: `refresh-${id}`, user: { id, app_metadata: { provider: 'email' }, identities: [{ id: `${provider}-${id}`, provider, identity_data: { sub: `${provider}-subject` } }] } } as unknown as Session;
}
function result(current: Session | null, error: unknown = null) { return { data: { session: current }, error }; }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (error: unknown) => void; const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; }); return { promise, resolve, reject }; }
class Page extends EventTarget { visibilityState: DocumentVisibilityState = 'visible'; }
function fixture() {
  const callbacks = new Set<(event: AuthChangeEvent, current: Session | null) => void>();
  const getSession = vi.fn().mockResolvedValue(result(null));
  const unsubscribe = vi.fn();
  const auth = {
    getSession, startAutoRefresh: vi.fn().mockResolvedValue(undefined), stopAutoRefresh: vi.fn().mockResolvedValue(undefined),
    onAuthStateChange: vi.fn((callback: (event: AuthChangeEvent, current: Session | null) => void) => {
      callbacks.add(callback);
      return { data: { subscription: { unsubscribe: () => { callbacks.delete(callback); unsubscribe(); } } } };
    }),
  };
  const browser = new EventTarget(), page = new Page(), states: NoteSessionState[] = [];
  const client = { auth } as unknown as SupabaseClient;
  const environment: NoteSessionEnvironment = { window: browser, document: page };
  const observe = () => observeNoteSession(client, state => states.push(state), environment);
  return { auth, client, browser, page, states, observe, unsubscribe, emit: (event: AuthChangeEvent, current: Session | null) => { for (const callback of callbacks) callback(event, current); } };
}
afterEach(() => { vi.restoreAllMocks(); });

describe('Google workspace identity', () => {
  it('accepts a Google-linked account whose primary provider is email', () => {
    expect(hasGoogleIdentity(session())).toBe(true);
    expect(hasGoogleIdentity(session('note-a', 'email'))).toBe(false);
    expect(hasGoogleIdentity(null)).toBe(false);
  });
  it('requires a nonempty Note ID and a Google identity ID or subject', () => {
    expect(hasGoogleIdentity(session('  '))).toBe(false);
    const current = session();
    current.user.identities = [{ provider: 'google', id: '', user_id: current.user.id, identity_id: 'google-identity', identity_data: { sub: ' ' } }];
    expect(hasGoogleIdentity(current)).toBe(false);
    current.user.identities![0].identity_data = { sub: 'actual-google-subject' };
    expect(hasGoogleIdentity(current)).toBe(true);
  });
});

describe('remembered Note session lifecycle', () => {
  it('loads the SDK session before opening the workspace and starts refresh only once', async () => {
    const f = fixture(), current = session(); f.auth.getSession.mockResolvedValue(result(current));
    const observer = f.observe();
    expect(f.states).toEqual([{ phase: 'loading', session: null, error: null }]);
    await observer.retry();
    expect(f.states.at(-1)).toEqual({ phase: 'session', session: current, error: null });
    expect(f.auth.getSession).toHaveBeenCalledTimes(1); expect(f.auth.startAutoRefresh).toHaveBeenCalledTimes(1);
    observer.dispose();
  });
  it('does not let a late restore overwrite a newer authenticated account', async () => {
    const f = fixture(), pending = deferred<ReturnType<typeof result>>(); f.auth.getSession.mockReturnValue(pending.promise);
    const observer = f.observe(), completion = observer.retry(); await Promise.resolve();
    const current = session('note-b'); f.emit('SIGNED_IN', current); pending.resolve(result(session('note-a'))); await completion;
    expect(f.states.at(-1)).toEqual({ phase: 'session', session: current, error: null }); observer.dispose();
  });
  it('keeps sign-out final when an older session restore completes afterward', async () => {
    const f = fixture(), pending = deferred<ReturnType<typeof result>>(); f.auth.getSession.mockReturnValue(pending.promise);
    const observer = f.observe(), completion = observer.retry(); await Promise.resolve();
    f.emit('SIGNED_IN', session()); f.emit('SIGNED_OUT', null); pending.resolve(result(session())); await completion;
    expect(f.states.at(-1)).toEqual({ phase: 'signed-out', session: null, error: null }); observer.dispose();
  });
  it('does not run automatic wake checks after sign-out and still accepts a new sign-in event', async () => {
    const f = fixture(); f.auth.getSession.mockResolvedValue(result(session())); const observer = f.observe(); await observer.retry();
    f.emit('SIGNED_OUT', null); const calls = f.auth.getSession.mock.calls.length;
    f.browser.dispatchEvent(new Event('focus')); f.browser.dispatchEvent(new Event('online')); f.page.dispatchEvent(new Event('visibilitychange')); await Promise.resolve();
    expect(f.auth.getSession).toHaveBeenCalledTimes(calls); expect(f.states.at(-1)?.phase).toBe('signed-out');
    const current = session('note-b'); f.emit('SIGNED_IN', current);
    expect(f.states.at(-1)).toEqual({ phase: 'session', session: current, error: null }); observer.dispose();
  });
  it('keeps an unknown startup retryable when the initial SDK null event accompanies a network failure', async () => {
    const f = fixture(), pending = deferred<ReturnType<typeof result>>(); f.auth.getSession.mockReturnValue(pending.promise);
    const observer = f.observe(), completion = observer.retry(); await Promise.resolve(); f.emit('INITIAL_SESSION', null);
    expect(f.states.at(-1)?.phase).toBe('loading');
    pending.resolve(result(null, new AuthRetryableFetchError('Network unavailable', 0))); await completion;
    expect(f.states.at(-1)).toEqual({ phase: 'error', session: null, error: 'Network unavailable' });
    f.auth.getSession.mockResolvedValue(result(session())); await observer.retry();
    expect(f.states.at(-1)?.phase).toBe('session'); observer.dispose();
  });
  it('retains a cached SDK-returned session when a refresh fails temporarily', async () => {
    const f = fixture(), cached = session(); f.auth.getSession.mockResolvedValue(result(cached, new AuthRetryableFetchError('Offline', 503)));
    const observer = f.observe(); await observer.retry();
    expect(f.states.at(-1)).toEqual({ phase: 'session', session: cached, error: 'Offline' }); observer.dispose();
  });
  it('keeps the already observed account through retryable wake errors and clears the warning on recovery', async () => {
    const f = fixture(), current = session(); f.auth.getSession.mockResolvedValue(result(current));
    const observer = f.observe(); await observer.retry();
    f.auth.getSession.mockRejectedValue(new TypeError('Failed to fetch')); await observer.retry();
    expect(f.states.at(-1)).toEqual({ phase: 'session', session: current, error: 'Failed to fetch' });
    f.auth.getSession.mockResolvedValue(result(current)); await observer.retry();
    expect(f.states.at(-1)?.error).toBeNull(); observer.dispose();
  });
  it('closes the workspace when the SDK confirms an invalid or missing refresh session', async () => {
    const f = fixture(); f.auth.getSession.mockResolvedValue(result(session())); const observer = f.observe(); await observer.retry();
    f.auth.getSession.mockResolvedValue(result(null, { status: 400, code: 'refresh_token_not_found', message: 'Sign in again.' })); await observer.retry();
    expect(f.states.at(-1)).toEqual({ phase: 'signed-out', session: null, error: 'Sign in again.' }); observer.dispose();
  });
  it('coalesces simultaneous visibility, online, focus, and manual session checks', async () => {
    const f = fixture(); f.auth.getSession.mockResolvedValue(result(session())); const observer = f.observe(); await observer.retry();
    const pending = deferred<ReturnType<typeof result>>(); f.auth.getSession.mockReturnValue(pending.promise);
    f.browser.dispatchEvent(new Event('focus')); f.browser.dispatchEvent(new Event('online')); f.page.dispatchEvent(new Event('visibilitychange'));
    const first = observer.retry(), second = observer.retry(); expect(first).toBe(second); await Promise.resolve();
    expect(f.auth.getSession).toHaveBeenCalledTimes(2); pending.resolve(result(session())); await first; observer.dispose();
  });
  it('stops background refresh while hidden and checks the session when the page becomes visible', async () => {
    const f = fixture(); f.auth.getSession.mockResolvedValue(result(session())); const observer = f.observe(); await observer.retry();
    f.page.visibilityState = 'hidden'; f.page.dispatchEvent(new Event('visibilitychange'));
    f.browser.dispatchEvent(new Event('focus')); f.browser.dispatchEvent(new Event('online')); await Promise.resolve(); await Promise.resolve();
    expect(f.auth.getSession).toHaveBeenCalledTimes(1);
    f.page.visibilityState = 'visible'; f.page.dispatchEvent(new Event('visibilitychange')); await observer.retry();
    expect(f.auth.getSession).toHaveBeenCalledTimes(2); expect(f.auth.stopAutoRefresh).toHaveBeenCalled(); observer.dispose();
  });
  it('serializes refresh teardown and restart across StrictMode remounts and removes old listeners', async () => {
    const f = fixture(), firstPending = deferred<ReturnType<typeof result>>(); f.auth.getSession.mockReturnValueOnce(firstPending.promise).mockResolvedValue(result(session()));
    const first = f.observe(); await Promise.resolve(); first.dispose(); const second = f.observe(); await second.retry();
    const count = f.states.length; firstPending.resolve(result(session('stale-account'))); await first.retry(); await Promise.resolve();
    expect(f.states).toHaveLength(count); expect(f.unsubscribe).toHaveBeenCalledTimes(1);
    f.browser.dispatchEvent(new Event('focus')); await second.retry(); expect(f.auth.getSession).toHaveBeenCalledTimes(3);
    second.dispose(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    await vi.waitFor(() => expect(f.auth.startAutoRefresh).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(f.auth.stopAutoRefresh).toHaveBeenCalledTimes(2));
    const calls = f.auth.getSession.mock.calls.length, states = f.states.length;
    f.browser.dispatchEvent(new Event('focus')); f.browser.dispatchEvent(new Event('online')); f.page.dispatchEvent(new Event('visibilitychange')); await Promise.resolve();
    expect(f.auth.getSession).toHaveBeenCalledTimes(calls); expect(f.states).toHaveLength(states); expect(f.unsubscribe).toHaveBeenCalledTimes(2);
  });
});
