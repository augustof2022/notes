/** Coalesce overlapping requests. A manual request during an upload gets a
 * fresh pass (and canvas flush) rather than silently reusing the older pass. */
export function createSyncRunner() {
  let running: Promise<void> | null = null;
  let next: (() => Promise<void>) | null = null;
  return {
    get busy() { return running !== null; },
    request(task: () => Promise<void>, queueIfBusy = true): Promise<void> {
      if (running) {
        if (queueIfBusy) next = task;
        return running;
      }
      next = task;
      // Defer task execution until running has been assigned, including when a
      // callback synchronously requests another sync.
      running = Promise.resolve().then(async () => {
        try { while (next) { const current = next; next = null; await current(); } }
        finally { running = null; next = null; }
      });
      return running;
    },
  };
}
export const SYNC_POLL_MS = 15000;
export const SYNC_IDLE_MS = 2000;
