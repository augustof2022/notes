const errorKeys = ['error', 'error_code', 'error_description'];

export function readOAuthReturn(href: string): { message: string; url: string } | null {
  const url = new URL(href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const failed = (params: URLSearchParams) => params.has('error') || params.has('error_code');
  const params = failed(url.searchParams) ? url.searchParams : failed(fragment) ? fragment : null;
  if (!params) return null;
  const code = params.get('error_code') || params.get('error') || '';
  const expired = code === 'flow_state_expired' || code === 'flow_state_not_found'
    || (code === 'bad_oauth_state' && /expired/i.test(params.get('error_description') || ''));
  const message = expired
    ? 'This Google sign-in request expired. Choose Continue with Google to start a fresh request, then finish sign-in in the Google tab.'
    : params.get('error') === 'access_denied'
      ? 'Google sign-in was not completed. Choose Continue with Google to try again when you are ready.'
      : 'Google sign-in could not finish. Choose Continue with Google to try again.';
  // Never show provider-supplied descriptions or retain the failed callback in the URL.
  if (failed(url.searchParams)) for (const key of errorKeys) url.searchParams.delete(key);
  if (failed(fragment)) {
    for (const key of errorKeys) fragment.delete(key);
    url.hash = fragment.toString();
  }
  return { message, url: url.href };
}
