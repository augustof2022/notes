import { Fragment, useEffect, useId, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { MoreHorizontal } from 'lucide-react';
import { colorSelection, coloredElements, displayedObjectColor, type ObjectColorRole } from '../lib/object-colors';
import { ColorField } from './ColorField';

interface ColorSlots { role: ObjectColorRole; section: HTMLElement; button: HTMLDivElement; content: HTMLDivElement }

/** Extend each native color section without moving DOM owned by the editor. */
export function ObjectColors({ api, root }: { api: ExcalidrawImperativeAPI; root: HTMLElement | null }) {
  const id = useId(), [open, setOpen] = useState<ObjectColorRole | null>(null), [, refresh] = useState(0);
  const [slots, setSlots] = useState<ColorSlots[]>([]);
  useLayoutEffect(() => {
    if (!root) return;
    const attached = new Map<HTMLElement, ColorSlots>();
    const detach = (slot: ColorSlots) => { slot.button.remove(); slot.content.remove(); slot.section.classList.remove('object-color-section'); };
    const locate = () => {
      const found = new Set<HTMLElement>(); let changed = false;
      const palettes = root.querySelectorAll<HTMLElement>('.selected-shape-actions .color-picker-container, .App-mobile-menu .color-picker-container');
      for (const palette of palettes) {
        const label = palette.querySelector('.active-color')?.getAttribute('aria-label');
        const role = label === 'Stroke' ? 'stroke' : label === 'Background' ? 'background' : null;
        const section = palette.parentElement?.parentElement;
        if (!role || !section) continue;
        found.add(section);
        const previous = attached.get(section);
        if (previous?.role === role && previous.button.parentElement === section && previous.content.parentElement === section) continue;
        if (previous) detach(previous);
        const button = document.createElement('div'), content = document.createElement('div');
        button.className = 'object-color-more-slot'; content.className = 'object-color-inline-slot';
        section.classList.add('object-color-section'); section.append(button, content);
        attached.set(section, { role, section, button, content }); changed = true;
      }
      for (const [section, slot] of attached) if (!found.has(section)) { detach(slot); attached.delete(section); changed = true; }
      if (changed) { setSlots([...attached.values()]); if (!attached.size) setOpen(null); }
    };
    locate(); const observer = new MutationObserver(locate); observer.observe(root, { childList: true, subtree: true });
    return () => { observer.disconnect(); for (const slot of attached.values()) detach(slot); };
  }, [root]);
  useEffect(() => open ? api.onChange((_elements, state) => { refresh(value => value + 1); if (state.openPopup) setOpen(null); }) : undefined, [api, open]);
  const state = api.getAppState(), elements = api.getSceneElements(), selected = Object.values(state.selectedElementIds).some(Boolean);
  function value(role: ObjectColorRole) {
    const colors = new Set(colorSelection(elements, state.selectedElementIds, role).map(element => displayedObjectColor(element, role)));
    return colors.size > 1 ? 'mixed' : [...colors][0] || (role === 'stroke' ? state.currentItemStrokeColor : state.currentItemBackgroundColor);
  }
  function apply(role: ObjectColorRole, color: string) {
    const current = api.getAppState();
    if (current.viewModeEnabled || current.newElement) return;
    api.updateScene({ elements: coloredElements(api.getSceneElementsIncludingDeleted(), current.selectedElementIds, role, color),
      appState: { currentItemStrokeColor: role === 'stroke' ? color : current.currentItemStrokeColor,
        currentItemBackgroundColor: role === 'background' ? color : current.currentItemBackgroundColor }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }
  function toggle(role: ObjectColorRole) {
    api.updateScene({ appState: { openPopup: null }, captureUpdate: CaptureUpdateAction.NEVER });
    setOpen(previous => previous === role ? null : role);
  }
  return <>{slots.map(({ role, button, content }, index) => {
    const label = role === 'stroke' ? 'Stroke' : 'Background', expanded = open === role, panelId = `${id}-${role}-${index}`;
    return <Fragment key={`${role}-${index}`}>
      {createPortal(<button type="button" className="object-color-more" aria-label={`More ${role} colors`} title={`Custom ${role} color and transparency`} aria-expanded={expanded} aria-controls={panelId} onClick={() => toggle(role)}><MoreHorizontal size={18} /></button>, button)}
      {createPortal(expanded && <div id={panelId} onKeyDown={event => {
        if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(null); button.querySelector('button')?.focus(); }
      }}><ColorField compact label={label} noneLabel={role === 'stroke' ? 'No stroke' : 'No background'} value={value(role)} onChange={color => apply(role, color)}
        disabled={state.viewModeEnabled || (selected && !colorSelection(elements, state.selectedElementIds, role).length)} /></div>, content)}
    </Fragment>;
  })}</>;
}
