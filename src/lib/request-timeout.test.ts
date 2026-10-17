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
