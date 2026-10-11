import { env, pipeline, RawImage, type ImageToTextPipeline } from '@huggingface/transformers';

// A single worker owns the model. Board images stay on the device.
env.allowLocalModels = false;
env.useBrowserCache = true;
env.backends.onnx.wasm!.numThreads = 1;
let reader: ImageToTextPipeline | null = null;
self.onmessage = async (event: MessageEvent<{ id: number; base: string; pixels: ArrayBuffer; width: number; height: number }>) => {
  const { id, base, pixels, width, height } = event.data;
  try {
    env.backends.onnx.wasm!.wasmPaths = `${base}handwriting/`;
    reader ||= await pipeline<'image-to-text'>('image-to-text', 'Xenova/trocr-small-handwritten', {
      device: 'wasm', dtype: 'q8', revision: 'b83e356c94a4b67dcb090f09584c10eed7f13d94',
      progress_callback: (progress: unknown) => self.postMessage({ id, progress }),
    });
    const result = await reader(new RawImage(new Uint8ClampedArray(pixels), width, height, 4), { max_new_tokens: 64 });
    const single = result.flat()[0];
    self.postMessage({ id, text: single?.generated_text || '' });
  } catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : 'Handwriting recognition is unavailable.' }); }
};
