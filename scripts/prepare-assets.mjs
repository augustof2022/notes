import { cp, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
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
console.log('Local fonts and English OCR assets ready.');
