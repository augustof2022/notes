/** Bound stalled cloud requests while preserving the caller's cancellation. */
export async function cloudFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  const upload = /\/storage\/v1\/object\/|\/upload\//.test(url);
  const controller = new AbortController();
  const signal = init?.signal || (typeof Request !== 'undefined' && input instanceof Request ? input.signal : null);
  let timedOut = false;
  // Keep caller cancellation linked after headers arrive: the response body
  // can still be streaming. Native any() avoids retaining a manual listener.
  const combined = signal && typeof AbortSignal.any === 'function' ? AbortSignal.any([controller.signal, signal]) : controller.signal;
  if (signal && combined === controller.signal) {
    const abort = () => controller.abort(signal.reason);
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  }
  // Large files (documents) get time to upload on a slow connection: at least 50 KB a second.
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, upload ? Math.max(90000, bodySize(init?.body) / 50) : 45000);
  try { return await fetch(input, { ...init, signal: combined }); }
  catch (error) {
    if (timedOut) throw new Error('The cloud request timed out. Your changes are saved on this device; check your connection and sync again.');
    throw error;
  } finally { clearTimeout(timer); }
}

function bodySize(body: BodyInit | null | undefined): number {
  if (typeof Blob !== 'undefined' && body instanceof Blob) return body.size;
  if (typeof FormData !== 'undefined' && body instanceof FormData) {
    let size = 0;
    body.forEach(value => { if (typeof value !== 'string') size += value.size; });
    return size;
  }
  return 0;
}
