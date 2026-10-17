/** Bound stalled cloud requests while preserving the caller's cancellation. */
export async function cloudFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const upload = /\/storage\/v1\/object\/|\/upload\//.test(url);
  const controller = new AbortController();
  const signal = init?.signal || (typeof Request !== 'undefined' && input instanceof Request ? input.signal : null);
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort(); else signal?.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, upload ? 90000 : 45000);
  try { return await fetch(input, { ...init, signal: controller.signal }); }
  catch (error) {
    if (timedOut) throw new Error('The cloud request timed out. Your changes are saved on this device; check your connection and sync again.');
    throw error;
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
