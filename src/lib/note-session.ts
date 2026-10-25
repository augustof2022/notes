import { isAuthRetryableFetchError, type Session, type SupabaseClient } from '@supabase/supabase-js';

export interface NoteSessionState {
  phase: 'loading' | 'session' | 'signed-out' | 'error';
  session: Session | null;
  error: string | null;
}
interface Events {
  addEventListener(type: string, callback: EventListener): void;
  removeEventListener(type: string, callback: EventListener): void;
}
export interface NoteSessionEnvironment {
  window?: Events;
  document?: Events & { readonly visibilityState: DocumentVisibilityState };
}
export interface NoteSessionObserver {
  retry(): Promise<void>;
  dispose(): void;
}

export function hasGoogleIdentity(session: Session | null): boolean {
  return typeof session?.user?.id === 'string' && !!session.user.id.trim()
    && Array.isArray(session.user.identities) && session.user.identities.some(identity => identity.provider === 'google'
      && [identity.id, identity.identity_data?.sub].some(id => typeof id === 'string' && !!id.trim()));
}

function terminalError(error: unknown): boolean {
  if (isAuthRetryableFetchError(error)) return false;
  const value = error as { status?: number; code?: string; name?: string } | null;
  return value?.name === 'AuthSessionMissingError' || [400, 401, 403].includes(value?.status || 0)
    || ['refresh_token_not_found', 'refresh_token_already_used', 'session_expired', 'session_not_found', 'bad_jwt', 'user_not_found', 'user_banned'].includes(value?.code || '');
}
function errorMessage(error: unknown) {
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message ? message : 'Your saved sign-in could not be checked. Check your connection and retry.';
}

// Serialize SDK timer changes across StrictMode's setup/cleanup/setup sequence.
// A late start from the previous observer must finish before its stop and the
// current observer's start, leaving only the current visibility state active.
const refreshChanges = new WeakMap<SupabaseClient['auth'], Promise<void>>();
function autoRefresh(client: SupabaseClient, active: boolean) {
  const previous = refreshChanges.get(client.auth) || Promise.resolve();
  const work = previous.catch(() => {}).then(async () => {
    if (active) await client.auth.startAutoRefresh(); else await client.auth.stopAutoRefresh();
  }).catch(() => {
    // Explicit getSession checks still surface connection/authentication errors.
  });
  refreshChanges.set(client.auth, work);
}

/** Own the SDK session lifecycle without reading or trusting browser storage. */
export function observeNoteSession(client: SupabaseClient, onState: (state: NoteSessionState) => void, environment: NoteSessionEnvironment = {}): NoteSessionObserver {
  const page = environment.document || (typeof document === 'undefined' ? undefined : document);
  const browser = environment.window || (typeof window === 'undefined' ? undefined : window);
  let alive = true, revision = 0, pending: Promise<void> | null = null, lastRefresh: boolean | undefined;
  let state: NoteSessionState = { phase: 'loading', session: null, error: null };
  const visible = () => !page || page.visibilityState !== 'hidden';
  const publish = (next: NoteSessionState) => { if (alive) { state = next; onState(next); } };
  const manageRefresh = (active: boolean) => {
    if (lastRefresh === active) return;
    lastRefresh = active; autoRefresh(client, active);
  };
  function retry(): Promise<void> {
    if (!alive) return Promise.resolve();
    if (pending) return pending;
    const requestedRevision = revision;
    // Begin in a microtask so a synchronous SDK failure cannot leave `pending`
    // pointing at an already completed operation.
    const operation = Promise.resolve().then(async () => {
      if (!alive) return;
      try {
        const { data, error } = await client.auth.getSession();
        if (!alive || revision !== requestedRevision) return;
        if (error) {
          if (terminalError(error)) { publish({ phase: 'signed-out', session: null, error: errorMessage(error) }); return; }
          // A retryable refresh may return a cached session. Use only the SDK's
          // result or a session already received from its authenticated events.
          const current = data.session || state.session;
          publish({ phase: current ? 'session' : 'error', session: current, error: errorMessage(error) });
        } else publish({ phase: data.session ? 'session' : 'signed-out', session: data.session, error: null });
      } catch (error) {
        if (!alive || revision !== requestedRevision) return;
        const current = terminalError(error) ? null : state.session;
        publish({ phase: terminalError(error) ? 'signed-out' : current ? 'session' : 'error', session: current, error: errorMessage(error) });
      }
    }).finally(() => { if (pending === operation) pending = null; });
    pending = operation;
    return operation;
  }
  publish(state);
  // Never await another auth call inside this callback: the SDK may hold its
  // refresh lock while delivering the event.
  const { data: subscription } = client.auth.onAuthStateChange((event, session) => {
    if (!alive) return;
    if (event === 'SIGNED_OUT') {
      revision++; publish({ phase: 'signed-out', session: null, error: null }); return;
    }
    if (!session) {
      // INITIAL_SESSION(null) also occurs after a transient restoration error.
      // The explicit SDK check distinguishes that case from a real sign-out.
      return;
    }
    revision++; publish({ phase: 'session', session, error: null });
  });
  const wake: EventListener = () => { if (visible()) { manageRefresh(true); if (state.phase !== 'signed-out') void retry(); } };
  const visibility: EventListener = () => {
    manageRefresh(visible());
    if (visible() && state.phase !== 'signed-out') void retry();
  };
  browser?.addEventListener('online', wake); browser?.addEventListener('focus', wake); browser?.addEventListener('pageshow', wake);
  page?.addEventListener('visibilitychange', visibility);
  manageRefresh(visible()); void retry();
  return {
    retry,
    dispose() {
      if (!alive) return;
      alive = false; revision++;
      subscription.subscription.unsubscribe();
      browser?.removeEventListener('online', wake); browser?.removeEventListener('focus', wake); browser?.removeEventListener('pageshow', wake);
      page?.removeEventListener('visibilitychange', visibility);
      manageRefresh(false);
    },
  };
}
