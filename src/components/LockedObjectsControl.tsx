import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { LockKeyhole, UnlockKeyhole } from 'lucide-react';
import { lockedObjects, type LockedObject } from '../lib/object-locks';
import { boardObjects, chosenObjects, selectedObjectKeys } from '../lib/board-objects';
import { setObjectsLocked } from '../lib/object-lock-scene';
import { Modal } from './Modal';

export function LockedObjectsControl({ api, root }: { api: ExcalidrawImperativeAPI; root: HTMLElement | null }) {
  const [objects, setObjects] = useState(() => lockedObjects(api.getSceneElements()));
  const [host, setHost] = useState<Element | null>(null);
  const [open, setOpen] = useState(false);
  const [selection, setSelection] = useState({ ids: [] as string[], locked: false, disabled: false });
  useLayoutEffect(() => { setHost(root?.querySelector('[data-toolbar-slot="actions-unlock"]') || null); }, [root]);
  useEffect(() => {
    const update = () => {
      const state = api.getAppState();
      if (state.cursorButton === 'down') {
        setSelection(previous => previous.disabled ? previous : { ...previous, disabled: true });
        return;
      }
      const next = lockedObjects(api.getSceneElements());
      setObjects(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
      const elements = api.getSceneElements(), tree = boardObjects(elements);
      const chosen = chosenObjects(tree, new Set(selectedObjectKeys(tree, state.selectedElementIds, state.selectedGroupIds)));
      const selection = { ids: chosen.flatMap(object => object.elementIds), locked: chosen.length > 0 && chosen.every(object => object.locked), disabled: state.viewModeEnabled || !!state.newElement };
      setSelection(previous => JSON.stringify(previous) === JSON.stringify(selection) ? previous : selection);
    };
    update(); return api.onChange(update);
  }, [api]);
  function unlock(items: LockedObject[]) {
    if (api.getAppState().viewModeEnabled) return;
    const ids = new Set(items.flatMap(item => item.elementIds));
    const selection: Record<string, true> = items.length === 1 ? Object.fromEntries([...ids].map(id => [id, true as const])) : {};
    const elements = setObjectsLocked(api.getSceneElementsIncludingDeleted(), ids, false);
    flushSync(() => {
      setOpen(false); api.setActiveTool({ type: 'selection' });
      api.updateScene({ elements, appState: { selectedElementIds: selection, selectedGroupIds: {}, openMenu: null }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    });
    api.scrollToContent(elements.filter(element => ids.has(element.id)), { fitToContent: false, animate: false });
    root?.querySelector<HTMLElement>('.excalidraw')?.focus();
  }
  function toggleSelection() {
    if (!selection.ids.length || selection.disabled) return;
    const elements = setObjectsLocked(api.getSceneElementsIncludingDeleted(), new Set(selection.ids), !selection.locked);
    api.updateScene({ elements, appState: { selectedElementIds: {}, selectedGroupIds: {}, editingLinearElement: null, selectedLinearElement: null }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    root?.querySelector<HTMLElement>('.excalidraw')?.focus();
  }
  return <>
    {host && createPortal(<button aria-label={selection.locked ? 'Unlock selection' : 'Lock selection'} disabled={!selection.ids.length || selection.disabled} title="Lock the selected object or entire group, including labels" onClick={toggleSelection}>{selection.locked ? <UnlockKeyhole size={15} /> : <LockKeyhole size={15} />}<span>{selection.locked ? 'Unlock selection' : 'Lock selection'}</span></button>, host)}
    {host && objects.length > 0 && createPortal(<button className="locked-objects-trigger" aria-label={`Unlock objects (${objects.length})`} aria-haspopup="dialog" onClick={() => setOpen(true)} title="Unlock objects without selecting them on the canvas"><UnlockKeyhole size={15} /><span>Unlock objects ({objects.length})</span></button>, host)}
    {open && createPortal(<Modal title="Locked objects" onClose={() => setOpen(false)}>
      <p className="dialog-description">Locked objects cannot be selected normally. Unlock an object here to move or edit it again.</p>
      <div className="locked-objects-list">{objects.map(object => <div key={object.id}><span>{object.label}</span><button className="secondary-button" aria-label={`Unlock ${object.label}`} onClick={() => unlock([object])}>Unlock</button></div>)}</div>
      {!objects.length && <p className="small-note">There are no locked objects on this board.</p>}
      <div className="dialog-actions"><button className="secondary-button" onClick={() => setOpen(false)}>Done</button>{objects.length > 1 && <button className="primary-button" onClick={() => unlock(objects)}>Unlock all objects</button>}</div>
    </Modal>, document.body)}
  </>;
}
