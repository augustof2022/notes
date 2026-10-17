import { expect, it, vi } from 'vitest';
import { createSyncRunner } from './sync-runner';
function deferred() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }
it('queues one fresh manual pass and waits for it while coalescing repeated clicks', async () => {
  const runner = createSyncRunner(), blocked = deferred(), next = deferred();
  const first = vi.fn(() => blocked.promise), second = vi.fn(() => next.promise), final = vi.fn(() => next.promise);
  const one = runner.request(first); await Promise.resolve();
  const two = runner.request(second), three = runner.request(final);
  expect(two).toBe(one); expect(three).toBe(one); expect(runner.busy).toBe(true);
  blocked.release(); await Promise.resolve(); await Promise.resolve();
  expect(second).not.toHaveBeenCalled(); expect(final).toHaveBeenCalledOnce();
  let done = false; void two.then(() => { done = true; }); await Promise.resolve(); expect(done).toBe(false);
  next.release(); await three; expect(runner.busy).toBe(false); expect(done).toBe(true);
});
it('does not build up interval retries while an upload is busy and recovers after failure', async () => {
  const runner = createSyncRunner(), blocked = deferred(), poll = vi.fn(async () => {});
  const active = runner.request(() => blocked.promise); await Promise.resolve();
  runner.request(poll, false); runner.request(poll, false); blocked.release(); await active;
  expect(poll).not.toHaveBeenCalled();
  await expect(runner.request(async () => { throw new Error('network'); })).rejects.toThrow('network');
  expect(runner.busy).toBe(false); await runner.request(poll); expect(poll).toHaveBeenCalledOnce();
});
