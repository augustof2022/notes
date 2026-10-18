import { afterEach, expect, it, vi } from 'vitest';
import { cloudFetch } from './request-timeout';
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
function stalledFetch() {
  vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn((_input, init: RequestInit) => new Promise((_resolve, reject) => {
    if (init.signal?.aborted) reject(init.signal.reason);
    else init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
  })));
}
it('times out stalled cloud calls and preserves a useful recovery message', async () => {
  stalledFetch(); const result = expect(cloudFetch('https://cloud.example/rest/v1/rpc/save_note')).rejects.toThrow('cloud request timed out');
  await vi.advanceTimersByTimeAsync(45000); await result; expect(vi.getTimerCount()).toBe(0);
});
it('allows longer image uploads and honors caller cancellation', async () => {
  stalledFetch(); const controller = new AbortController();
  const result = expect(cloudFetch('https://cloud.example/storage/v1/object/note-images/one', { signal: controller.signal })).rejects.toThrow('Stopped by caller');
  await vi.advanceTimersByTimeAsync(45000); expect(vi.getTimerCount()).toBe(1);
  controller.abort(new Error('Stopped by caller')); await result; expect(vi.getTimerCount()).toBe(0);
});

it.each([true, false])('preserves body cancellation with native signal combination: %s', async native => {
  if (!native) vi.stubGlobal('AbortSignal', {});
  const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream()));
  vi.stubGlobal('fetch', fetchMock);
  const controller = new AbortController();
  const response = await cloudFetch('https://www.googleapis.com/drive/v3/files/image?alt=media', { signal: controller.signal });
  expect(response.body).not.toBeNull();
  controller.abort();
  expect((fetchMock.mock.calls[0][1].signal as AbortSignal).aborted).toBe(true);
});
