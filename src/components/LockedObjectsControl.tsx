import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { CaptureUpdateAction, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { UnlockKeyhole } from 'lucide-react';
import { lockedObjects, type LockedObject } from '../lib/object-locks';
import { Modal } from './Modal';

export function LockedObjectsControl({ api, root }: { api: ExcalidrawImperativeAPI; root: HTMLElement | null }) {
  const [objects, setObjects] = useState(() => lockedObjects(api.getSceneElements()));
  const [host, setHost] = useState<Element | null>(null);
  const [open, setOpen] = useState(false);
  useLayoutEffect(() => { setHost(root?.querySelector('.canvas-tools') || null); }, [root]);
  useEffect(() => {
    const update = () => {
      const next = lockedObjects(api.getSceneElements());
      setObjects(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
    };
    update(); return api.onChange(update);
  }, [api]);
  function unlock(items: LockedObject[]) {
    const ids = new Set(items.flatMap(item => item.elementIds));
    const selection: Record<string, true> = items.length === 1 ? Object.fromEntries([...ids].map(id => [id, true as const])) : {};
    const elements = api.getSceneElementsIncludingDeleted().map(element => !element.isDeleted && ids.has(element.id) ? newElementWith(element, { locked: false }) : element);
    flushSync(() => {
      setOpen(false); api.setActiveTool({ type: 'selection' });
      api.updateScene({ elements, appState: { selectedElementIds: selection, selectedGroupIds: {}, openMenu: null }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    });
    api.scrollToContent(elements.filter(element => ids.has(element.id)), { fitToContent: false, animate: false });
    root?.querySelector<HTMLElement>('.excalidraw')?.focus();
  }
  return <>
    {host && objects.length > 0 && createPortal(<button className="locked-objects-trigger" aria-haspopup="dialog" onClick={() => setOpen(true)} title="Unlock objects without selecting them on the canvas"><UnlockKeyhole size={15} />Unlock objects ({objects.length})</button>, host)}
    {open && createPortal(<Modal title="Locked objects" onClose={() => setOpen(false)}>
      <p className="dialog-description">Locked objects cannot be selected normally. Unlock an object here to move or edit it again.</p>
      <div className="locked-objects-list">{objects.map(object => <div key={object.id}><span>{object.label}</span><button className="secondary-button" aria-label={`Unlock ${object.label}`} onClick={() => unlock([object])}>Unlock</button></div>)}</div>
      {!objects.length && <p className="small-note">There are no locked objects on this board.</p>}
      <div className="dialog-actions"><button className="secondary-button" onClick={() => setOpen(false)}>Done</button>{objects.length > 1 && <button className="primary-button" onClick={() => unlock(objects)}>Unlock all objects</button>}</div>
    </Modal>, document.body)}
  </>;
}
