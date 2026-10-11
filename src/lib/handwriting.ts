export function createHandwritingReader(onProgress: (message: string) => void) {
  const worker = new Worker(new URL('./handwriting.worker.ts', import.meta.url), { type: 'module' });
  let nextId = 0;
  const pending = new Map<number, { resolve: (text: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  function fail(error: Error) { for (const job of pending.values()) { clearTimeout(job.timer); job.reject(error); } pending.clear(); }
  worker.onerror = () => fail(new Error('Could not load the handwriting reader. You can enter the words yourself.'));
  worker.onmessage = (event: MessageEvent<{ id: number; text?: string; error?: string; progress?: { status?: string; progress?: number } }>) => {
    const { id, text, error, progress } = event.data, job = pending.get(id); if (!job) return;
    if (progress) { onProgress(progress.status === 'progress' ? `Downloading handwriting model… ${Math.round(progress.progress || 0)}%` : 'Preparing handwriting reader…'); return; }
    clearTimeout(job.timer); pending.delete(id);
    if (error) job.reject(new Error(error)); else job.resolve(text || '');
  };
  return {
    read(canvas: HTMLCanvasElement) {
      const id = ++nextId, pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('The reader took too long. Retry or enter the words yourself.')); }, 180000);
        pending.set(id, { resolve, reject, timer });
        worker.postMessage({ id, base: new URL(import.meta.env.BASE_URL, location.href).href, pixels: pixels.buffer, width: canvas.width, height: canvas.height }, [pixels.buffer]);
      });
    },
    close() { worker.terminate(); fail(new Error('Handwriting recognition cancelled.')); },
  };
}
