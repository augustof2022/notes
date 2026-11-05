import { useEffect, useRef, useState } from 'react';
import { exportToCanvas } from '@excalidraw/excalidraw';
import type { ExcalidrawElement, NonDeleted } from '@excalidraw/excalidraw/element/types';
import type { BinaryFiles } from '@excalidraw/excalidraw/types';
import { Image, Layers, Pencil, Shapes, Type, ArrowUpRight } from 'lucide-react';
import type { BoardObject } from '../lib/board-objects';

const cache = new Map<string, Promise<string | undefined>>();
const pending: (() => Promise<void>)[] = [];
let active = 0;
function drain() {
  while (active < 2 && pending.length) {
    const job = pending.shift()!; active++;
    void job().finally(() => { active--; drain(); });
  }
}
function preview(key: string, elements: readonly ExcalidrawElement[], files: BinaryFiles, dark: boolean) {
  const cached = cache.get(key); if (cached) return cached;
  const snapshot = structuredClone(elements);
  const promise = new Promise<string | undefined>(resolve => {
    pending.push(async () => {
      try {
        const canvas = await exportToCanvas({ elements: snapshot as readonly NonDeleted<ExcalidrawElement>[], files, maxWidthOrHeight: 192, exportPadding: 10,
          appState: { exportBackground: false, exportWithDarkMode: dark } });
        resolve(canvas.toDataURL('image/png'));
      } catch { resolve(undefined); }
    });
    drain();
  });
  cache.set(key, promise); if (cache.size > 160) cache.delete(cache.keys().next().value!);
  return promise;
}

export function LayerPreview({ scope, object, elements, files, dark }: { scope: string; object: BoardObject; elements: ReadonlyMap<string, ExcalidrawElement>; files: BinaryFiles; dark: boolean }) {
  const host = useRef<HTMLSpanElement>(null), [visible, setVisible] = useState(false), [url, setUrl] = useState<string>();
  const members = object.elementIds.flatMap(id => elements.get(id) || []);
  const signature = `${scope}:${dark}:${members.map(element => `${element.id}:${element.version}:${element.versionNonce}:${element.type === 'image' && element.fileId ? files[element.fileId]?.created || 'missing' : ''}`).join('|')}`;
  useEffect(() => {
    if (!host.current) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) { setVisible(true); observer.disconnect(); } }, { root: host.current.closest('.layers-list'), rootMargin: '80px' });
    observer.observe(host.current); return () => observer.disconnect();
  }, []);
  useEffect(() => {
    if (!visible) return;
    let alive = true; setUrl(undefined);
    void preview(signature, members, files, dark).then(value => { if (alive) setUrl(value); });
    return () => { alive = false; };
  }, [visible, signature]);
  const Icon = object.kind === 'Group' ? Layers : object.kind === 'Text' ? Type : object.kind === 'Image' ? Image : object.kind === 'Drawing' ? Pencil : object.kind === 'Connection' || object.kind === 'Line' ? ArrowUpRight : Shapes;
  return <span ref={host} className="layer-preview" aria-hidden="true">{url ? <img src={url} alt="" draggable={false} /> : <Icon size={20} />}</span>;
}
