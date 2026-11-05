import { useEffect, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { Palette } from 'lucide-react';
import { colorSelection, coloredElements, displayedObjectColor, type ObjectColorRole } from '../lib/object-colors';
import { Modal } from './Modal';
import { ColorField } from './ColorField';

export function ObjectColors({ api, root }: { api: ExcalidrawImperativeAPI; root: HTMLElement | null }) {
  const [host, setHost] = useState<Element | null>(null), [open, setOpen] = useState(false), [, refresh] = useState(0);
  const [palette, setPalette] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => { setHost(root?.querySelector('[data-toolbar-slot="actions-colors"]') || null); }, [root]);
  useLayoutEffect(() => {
    if (!root) return;
    let target: Element | null = null, slot: HTMLDivElement | null = null;
    const locate = () => {
      const next = root.querySelector('.excalidraw .selected-shape-actions .panelColumn, .excalidraw--mobile .App-mobile-menu .panelColumn');
      if (next === target) return;
      slot?.remove(); target = next;
      if (target) { slot = document.createElement('div'); slot.className = 'object-more-colors'; target.prepend(slot); setPalette(slot); }
      else { slot = null; setPalette(null); }
    };
    locate(); const observer = new MutationObserver(locate); observer.observe(root, { childList: true, subtree: true });
    return () => { observer.disconnect(); slot?.remove(); };
  }, [root]);
  useEffect(() => open ? api.onChange(() => refresh(value => value + 1)) : undefined, [api, open]);
  const state = api.getAppState(), elements = api.getSceneElements(), selected = Object.values(state.selectedElementIds).some(Boolean);
  function value(role: ObjectColorRole) {
    const colors = new Set(colorSelection(elements, state.selectedElementIds, role).map(element => displayedObjectColor(element, role)));
    return colors.size > 1 ? 'mixed' : [...colors][0] || (role === 'stroke' ? state.currentItemStrokeColor : state.currentItemBackgroundColor);
  }
  function apply(role: ObjectColorRole, color: string) {
    if (state.viewModeEnabled || state.newElement) return;
    api.updateScene({ elements: coloredElements(api.getSceneElementsIncludingDeleted(), api.getAppState().selectedElementIds, role, color),
      appState: { currentItemStrokeColor: role === 'stroke' ? color : api.getAppState().currentItemStrokeColor,
        currentItemBackgroundColor: role === 'background' ? color : api.getAppState().currentItemBackgroundColor }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }
  return <>
    {host && createPortal(<button aria-label="Stroke and background colors" aria-haspopup="dialog" onClick={() => setOpen(true)} title="More colors, custom picker, and transparent stroke or background"><Palette size={16} /><span>Colors</span></button>, host)}
    {palette && createPortal(<button className="object-more-colors-button" onClick={() => setOpen(true)}><Palette size={15} />More colors &amp; transparent</button>, palette)}
    {open && createPortal(<Modal title="Stroke and background colors" onClose={() => setOpen(false)}>
      <p className="dialog-description">{selected ? 'Choose colors for the selected objects. Locked objects stay protected.' : 'Choose the colors for your next shapes, drawings, text, and connections.'}</p>
      <ColorField label="Stroke" noneLabel="No stroke" value={value('stroke')} onChange={color => apply('stroke', color)} disabled={state.viewModeEnabled || (selected && !colorSelection(elements, state.selectedElementIds, 'stroke').length)} />
      <ColorField label="Background" noneLabel="No background" value={value('background')} onChange={color => apply('background', color)} disabled={state.viewModeEnabled || (selected && !colorSelection(elements, state.selectedElementIds, 'background').length)} />
      <div className="dialog-actions"><button className="primary-button" onClick={() => setOpen(false)}>Done</button></div>
    </Modal>, document.body)}
  </>;
}
