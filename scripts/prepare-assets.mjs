import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import './check-version.mjs';
const dest = join(process.cwd(), 'public');
await mkdir(join(dest, 'excalidraw'), { recursive: true });
await cp('node_modules/@excalidraw/excalidraw/dist/prod/fonts', join(dest, 'excalidraw/fonts'), { recursive: true });
await mkdir(join(dest, 'ocr'), { recursive: true });
await cp('node_modules/tesseract.js/dist/worker.min.js', join(dest, 'ocr/worker.min.js'));
await cp('node_modules/tesseract.js-core', join(dest, 'ocr/core'), {
  recursive: true, filter: path => !path.endsWith('README.md') && !path.endsWith('package.json')
});
await cp('node_modules/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz', join(dest, 'ocr/eng.traineddata.gz'));
await cp('supabase/schema.sql', join(dest, 'setup.sql'));
await cp('supabase/repair-creation-dates.sql', join(dest, 'repair-creation-dates.sql'));
await mkdir(join(dest, 'handwriting'), { recursive: true });
for (const file of ['ort-wasm-simd-threaded.wasm', 'ort-wasm-simd-threaded.mjs', 'ort-wasm-simd-threaded.jsep.wasm', 'ort-wasm-simd-threaded.jsep.mjs']) {
  await cp(join('node_modules/onnxruntime-web/dist', file), join(dest, 'handwriting', file));
}
console.log('Local fonts and English OCR assets ready.');
