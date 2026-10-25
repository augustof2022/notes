import { ArrowUpRight, Cloud, Loader2, RefreshCw } from 'lucide-react';
import { APP_VERSION } from '../lib/version';

interface Props {
  loading: boolean; busy: boolean; configured: boolean; recovering: boolean;
  error: string; existingEmail?: string; onGoogle: () => void; onRetry: () => void;
}
export function SignInScreen({ loading, busy, configured, recovering, error, existingEmail, onGoogle, onRetry }: Props) {
  return <main className="sign-in-page">
    <section className="sign-in-card" aria-labelledby="sign-in-title" aria-busy={loading || busy}>
      <a className="sign-in-brand" href="./about.html"><img src="./icon.svg" width="44" height="44" alt="" /><span>Note<small>a little room for big ideas</small></span></a>
      <div className="sign-in-emblem" aria-hidden="true"><Cloud size={26} /></div>
      <h1 id="sign-in-title">Your ideas.<br />Your own workspace.</h1>
      <p className="sign-in-lead">Sign in with Google to open your boards and keep your notes and images together across devices.</p>
      {loading ? <p className="sign-in-loading" role="status"><Loader2 className="spinning" size={18} />Restoring your session…</p> : <>
        {existingEmail && <p className="sign-in-account">Continue with the Google account for <strong>{existingEmail}</strong> to open your existing workspace.</p>}
        {error && <p className="form-error" role="alert">{error}</p>}
        {recovering && configured && <button type="button" className="secondary-button sign-in-retry" disabled={busy} onClick={onRetry}><RefreshCw size={16} />Retry connection</button>}
        <button type="button" className="google-sign-in" disabled={busy || !configured} onClick={onGoogle}>
          {busy ? <Loader2 className="spinning" size={18} /> : <svg aria-hidden="true" width="19" height="19" viewBox="0 0 24 24"><path fill="#4285f4" d="M21.6 12.23c0-.71-.06-1.39-.18-2.05H12v3.88h5.38a4.6 4.6 0 0 1-2 3.02v2.51h3.24c1.9-1.75 2.98-4.33 2.98-7.36Z"/><path fill="#34a853" d="M12 22c2.7 0 4.96-.9 6.62-2.41l-3.24-2.51c-.9.6-2.05.97-3.38.97-2.6 0-4.81-1.76-5.6-4.12H3.06v2.59A10 10 0 0 0 12 22Z"/><path fill="#fbbc05" d="M6.4 13.93A6 6 0 0 1 6.09 12c0-.67.11-1.32.31-1.93V7.48H3.06A10 10 0 0 0 2 12c0 1.61.38 3.14 1.06 4.52l3.34-2.59Z"/><path fill="#ea4335" d="M12 5.95c1.47 0 2.79.5 3.82 1.5l2.87-2.87A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.94 5.48l3.34 2.59C7.19 7.71 9.4 5.95 12 5.95Z"/></svg>}
          {busy ? 'Opening Google…' : 'Continue with Google'}{!busy && <ArrowUpRight size={16} />}
        </button>
        <p className="sign-in-hint">New here? Your account is created when you continue.<br />Note remembers your sign-in on this browser.</p>
        <p className="sign-in-permission">Google asks permission to save and load your board images in your private “Note images” folder. Access renews in the background when connected.</p>
      </>}
      <p className="sign-in-policy">Cloud notes are accessible to the service operator. Read our <a href="./privacy.html">privacy policy</a> and <a href="./terms.html">terms</a> before continuing.</p>
    </section>
    <footer className="sign-in-footer"><a href="./about.html">About Note</a><a href="./updates.html">v{APP_VERSION}</a><span>Your space to think.</span></footer>
  </main>;
}
