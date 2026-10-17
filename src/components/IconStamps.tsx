import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { ChevronDown, Search, Stamp, X } from 'lucide-react';
import { DEFAULT_STAMP, STAMP_COLORS, filterStampIcons, isStampShortcut, readStampPreferences, saveStampPreferences, stampIcon, stampPosition, type StampPreferences } from '../lib/icon-stamps';
import { createIconStamp } from '../lib/icon-stamp-scene';
import { Modal } from './Modal';
import './icon-stamps.css';

const STAMP_TOOL = 'note-icon-stamp';
export function IconStamps({ api, root, onMessage }: { api: ExcalidrawImperativeAPI; root: HTMLElement | null; onMessage: (text: string) => void }) {
  const [preferences, setPreferences] = useState(readStampPreferences);
  const [host, setHost] = useState<Element | null>(null);
  const [opened, setOpened] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(false);
  const operation = useRef(0);
  const nativeStamp = useRef(false);
  const live = useRef({ preferences, opened, active }); live.current = { preferences, opened, active };
  const chosen = stampIcon(preferences.iconId), Icon = chosen.icon;
  useLayoutEffect(() => { setHost(root?.querySelector('[data-toolbar-slot="actions-stamps"]') || null); }, [root]);
  useEffect(() => api.onChange((_elements, state) => {
    const stamping = state.activeTool.type === 'custom' && state.activeTool.customType === STAMP_TOOL;
    const leaving = nativeStamp.current && !stamping;
    nativeStamp.current = stamping; setActive(stamping);
    // Native pointer cleanup otherwise returns custom tools to selection. Keep
    // this tool armed, then release its lock when a native tool is chosen.
    if ((stamping && !state.activeTool.locked) || (leaving && state.activeTool.locked)) {
      api.updateScene({ appState: { activeTool: { ...state.activeTool, locked: stamping } }, captureUpdate: CaptureUpdateAction.NEVER });
    }
  }), [api]);
  function update(next: StampPreferences) { setPreferences(next); saveStampPreferences(next); }
  function stop() { operation.current++; api.setActiveTool({ type: 'selection', locked: false }); api.resetCursor(); setActive(false); }
  function activate() {
    operation.current++;
    flushSync(() => { setOpened(false); setActive(true); });
    root?.dispatchEvent(new Event('note:icon-stamp'));
    api.updateScene({ appState: { selectedElementIds: {}, selectedGroupIds: {}, openMenu: null, editingLinearElement: null, selectedLinearElement: null, croppingElementId: null }, captureUpdate: CaptureUpdateAction.NEVER });
    api.setActiveTool({ type: 'custom', customType: STAMP_TOOL, locked: true }); api.setCursor('crosshair');
    root?.querySelector<HTMLElement>('.excalidraw')?.focus();
  }
  useEffect(() => {
    if (!root) return;
    const key = (event: KeyboardEvent) => {
      const target = event.target, state = api.getAppState();
      if (!(target instanceof HTMLElement) || (!root.contains(target) && target !== document.body && !target.closest('.topbar')) || root.inert || live.current.opened
        || target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], [role="menu"], .dropdown-menu')
        || document.querySelector('.modal-backdrop') || state.editingTextElement || state.openDialog || state.viewModeEnabled) return;
      if (event.repeat && live.current.active && event.key.toLowerCase() === 'i' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault(); event.stopImmediatePropagation(); return;
      }
      if (isStampShortcut(event)) { event.preventDefault(); event.stopImmediatePropagation(); activate(); }
      else if (event.key === 'Escape' && live.current.active) { event.preventDefault(); event.stopImmediatePropagation(); stop(); }
    };
    document.addEventListener('keydown', key, true);
    // Diagram placement and icon stamping are mutually exclusive canvas tools.
    const cancel = () => { if (live.current.active) stop(); };
    root.addEventListener('note:diagram-placement', cancel);
    return () => { document.removeEventListener('keydown', key, true); root.removeEventListener('note:diagram-placement', cancel); };
  }, [api, root]);
  useEffect(() => {
    if (!root) return;
    let down: { x: number; y: number; id: number } | null = null;
    let cancelled = false, space = false, frame = 0;
    const pointers = new Set<number>();
    const trackDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest('.excalidraw canvas')) return;
      if (!pointers.size) cancelled = false;
      pointers.add(event.pointerId); if (pointers.size > 1) cancelled = true;
    };
    const trackMove = (event: PointerEvent) => {
      if (down?.id === event.pointerId && Math.hypot(event.clientX - down.x, event.clientY - down.y) > 8) cancelled = true;
    };
    const trackUp = (event: PointerEvent) => { pointers.delete(event.pointerId); };
    const trackKey = (event: KeyboardEvent) => { if (event.code === 'Space') space = event.type === 'keydown'; };
    const reset = () => { down = null; pointers.clear(); cancelled = true; space = false; };
    const offDown = api.onPointerDown((tool, _state, event) => {
      down = tool.type === 'custom' && tool.customType === STAMP_TOOL && event.button === 0 && !space
        ? { x: event.clientX, y: event.clientY, id: event.pointerId } : null;
    });
    const offUp = api.onPointerUp((tool, _state, event) => {
      const origin = down; down = null;
      if (!origin || tool.type !== 'custom' || tool.customType !== STAMP_TOOL || cancelled || space || live.current.opened
        || event.type === 'pointercancel' || Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > 8) return;
      const client = { x: event.clientX, y: event.clientY }, settings = { ...live.current.preferences }, token = operation.current;
      // Finish the editor's pointer cleanup before selecting the new stamp for resizing.
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (operation.current !== token || root.inert || live.current.opened) return;
        const tool = api.getAppState().activeTool;
        if (tool.type !== 'selection' && !(tool.type === 'custom' && tool.customType === STAMP_TOOL)) return;
        try {
          const { file, element } = createIconStamp(settings, stampPosition(client, api.getAppState(), settings.size));
          api.addFiles([file]);
          if (settings.repeat) { api.setCursor('crosshair'); setActive(true); }
          else { api.setActiveTool({ type: 'selection', locked: false }); api.resetCursor(); setActive(false); }
          api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), element], appState: {
            selectedElementIds: settings.repeat ? {} : { [element.id]: true }, selectedGroupIds: {}, openMenu: null,
          }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
        } catch (error) { onMessage(error instanceof Error ? error.message : 'Could not place this icon.'); }
      });
    });
    root.addEventListener('pointerdown', trackDown, true);
    window.addEventListener('pointermove', trackMove, true); window.addEventListener('pointerup', trackUp, true);
    window.addEventListener('pointercancel', reset, true); window.addEventListener('blur', reset);
    window.addEventListener('keydown', trackKey, true); window.addEventListener('keyup', trackKey, true);
    return () => {
      offDown(); offUp(); if (frame) cancelAnimationFrame(frame);
      root.removeEventListener('pointerdown', trackDown, true);
      window.removeEventListener('pointermove', trackMove, true); window.removeEventListener('pointerup', trackUp, true);
      window.removeEventListener('pointercancel', reset, true); window.removeEventListener('blur', reset);
      window.removeEventListener('keydown', trackKey, true); window.removeEventListener('keyup', trackKey, true);
    };
  }, [api, root, onMessage]);
  return <>
    {host && createPortal(<div className="icon-stamp-controls">
      <button className="icon-stamp-trigger" aria-pressed={active} aria-label={`Stamp icon: ${chosen.name}. Shortcut I`} title={`${chosen.meaning} · Press I, then tap or click the board`} onClick={active ? stop : activate}>
        <Icon size={20} color={preferences.color} /><span>{chosen.name}</span><kbd>I</kbd>
      </button>
      <button className="icon-stamp-picker-trigger" aria-label="Choose stamp icon" title="Choose an icon, color, and size" aria-haspopup="dialog" onClick={() => { setQuery(''); setOpened(true); }}><ChevronDown size={16} /></button>
    </div>, host)}
    {active && <div className="icon-stamp-status" role="status"><Icon size={20} color={preferences.color} /><span>Tap or click to stamp <strong>{chosen.name}</strong>{preferences.repeat ? ' · Keep stamping is on' : ''}</span><button onClick={stop} aria-label="Stop stamping" title="Stop stamping (Esc)"><X size={17} /></button></div>}
    {opened && createPortal(<Modal title="Icon stamps" wide onClose={() => setOpened(false)}>
      <div className="icon-stamp-picker-body">
      <p className="dialog-description">Mark questions, reminders, research, and more. Choose an icon, then tap or left-click the board. Resize it using its corner handles.</p>
      <label className="icon-stamp-search"><Search size={18} /><input type="search" aria-label="Search stamp icons" placeholder="Search icons or meanings…" value={query} onChange={event => setQuery(event.target.value)} /></label>
      <div className="icon-stamp-grid" role="group" aria-label="Stamp icons">{filterStampIcons(query).map(icon => { const Preview = icon.icon; return <button key={icon.id} aria-pressed={preferences.iconId === icon.id} title={icon.meaning} onClick={() => update({ ...preferences, iconId: icon.id })}>
        <Preview size={26} color={preferences.color} /><strong>{icon.name}</strong><small>{icon.meaning}</small>
      </button>; })}</div>
      {!filterStampIcons(query).length && <p className="small-note">No matching icons. Try “question”, “task”, or “idea”.</p>}
      <div className="icon-stamp-settings"><fieldset><legend>Color</legend><div className="icon-stamp-colors">{STAMP_COLORS.map(color => <button key={color} style={{ backgroundColor: color }} aria-label={`Stamp color ${color}`} aria-pressed={preferences.color === color} onClick={() => update({ ...preferences, color })} />)}<input type="color" aria-label="Custom stamp color" value={preferences.color} onChange={event => update({ ...preferences, color: event.target.value })} /></div></fieldset>
        <label>Size<select value={preferences.size} onChange={event => update({ ...preferences, size: Number(event.target.value) })}>{[24, 32, DEFAULT_STAMP.size, 72, 96, 160].map(size => <option key={size} value={size}>{size} px</option>)}</select></label>
      </div>
      <label className="icon-stamp-repeat"><input type="checkbox" checked={preferences.repeat} onChange={event => update({ ...preferences, repeat: event.target.checked })} /><span>Keep stamping<small>Place several icons, then press Esc or choose another tool to select and resize them.</small></span></label>
      <div className="icon-stamp-preview"><Icon size={32} color={preferences.color} /><span><strong>{chosen.name}</strong><small>{chosen.meaning}</small></span><kbd>I</kbd></div>
      </div>
      <div className="dialog-actions"><button className="secondary-button" onClick={() => setOpened(false)}>Cancel</button><button className="primary-button" onClick={activate}><Stamp size={16} />Use {chosen.name}</button></div>
    </Modal>, document.body)}
  </>;
}
