import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { ChevronDown, ChevronRight, Group, Layers, LocateFixed, LockKeyhole, Minus, Search, Ungroup, UnlockKeyhole, X } from 'lucide-react';
import { boardObjects, chosenObjects, lockTargets, objectSelection, readLayerPreferences, saveLayerPreferences, selectedObjectKeys, toggleObjectKey, type BoardObject, type LayerPreferences } from '../lib/board-objects';
import { setObjectsLocked } from '../lib/object-lock-scene';
import { LayerPreview } from './LayerPreview';
import { contentFingerprint } from '../lib/canvas-signature';
import './layers.css';

export function LayersSidebar({ api, root, scope, onMessage }: { api: ExcalidrawImperativeAPI; root: HTMLElement | null; scope: string; onMessage: (message: string) => void }) {
  const [preferences, setPreferences] = useState(readLayerPreferences);
  const preferencesRef = useRef(preferences); preferencesRef.current = preferences;
  const [host, setHost] = useState<Element | null>(null), [parent, setParent] = useState<HTMLElement | null>(null);
  const [snapshot, setSnapshot] = useState(() => ({ elements: api.getSceneElements(), files: api.getFiles(), state: api.getAppState(), objects: boardObjects(api.getSceneElements()) }));
  const [selected, setSelected] = useState(new Set<string>()), [expanded, setExpanded] = useState(new Set<string>()), [search, setSearch] = useState('');
  const lastSelection = useRef(''), rangeAnchor = useRef<string | undefined>(undefined), list = useRef<HTMLDivElement>(null), aside = useRef<HTMLElement>(null);
  const resizeCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => resizeCleanup.current?.(), []);
  useLayoutEffect(() => { setHost(root?.closest('.main-content')?.querySelector('.board-header-tools') || null); setParent(root?.parentElement || null); }, [root]);
  useLayoutEffect(() => { parent?.classList.toggle('layers-open', preferences.open); return () => parent?.classList.remove('layers-open'); }, [parent, preferences.open]);
  function update(patch: Partial<LayerPreferences>) {
    setPreferences(previous => { const next = { ...previous, ...patch }; preferencesRef.current = next; saveLayerPreferences(next); return next; });
  }
  function hide() { update({ open: false }); requestAnimationFrame(() => host?.querySelector<HTMLButtonElement>('.layers-toggle')?.focus()); }
  useEffect(() => {
    if (!preferences.open) { resizeCleanup.current?.(); return; }
    let frame = 0, lastContent = '';
    const refresh = () => {
      frame = 0;
      const state = api.getAppState();
      if (state.cursorButton === 'down') return; // Do not export previews during a pen/drag gesture.
      const elements = api.getSceneElements();
      const signature = JSON.stringify([state.selectedElementIds, state.selectedGroupIds]);
      const content = `${contentFingerprint(elements)}|${signature}|${Object.keys(api.getFiles()).length}`;
      if (content === lastContent) return; // Pan and zoom change neither the layers nor the selection.
      lastContent = content;
      const objects = boardObjects(elements);
      if (signature !== lastSelection.current) {
        lastSelection.current = signature;
        const keys = selectedObjectKeys(objects, state.selectedElementIds, state.selectedGroupIds);
        setSelected(new Set(keys));
        const selectedIds = new Set(keys);
        const ancestors = (nodes: BoardObject[]): boolean => nodes.reduce((found, node) => {
          const child = ancestors(node.children);
          if (child) setExpanded(previous => new Set([...previous, node.key]));
          return found || child || selectedIds.has(node.key);
        }, false);
        ancestors(objects);
      }
      setSnapshot({ elements, files: api.getFiles(), state, objects });
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(refresh); };
    lastSelection.current = ''; refresh();
    const stop = api.onChange(schedule);
    return () => { stop(); if (frame) cancelAnimationFrame(frame); };
  }, [api, preferences.open]);
  const objects = snapshot.objects, chosen = chosenObjects(objects, selected);
  const elementsById = useMemo(() => new Map(snapshot.elements.map(element => [element.id, element])), [snapshot.elements]);
  const filter = search.trim().toLowerCase();
  const matches = (object: BoardObject): boolean => `${object.label} ${object.kind}`.toLowerCase().includes(filter) || object.children.some(matches);
  const visibleRows: BoardObject[] = [];
  function collect(nodes: BoardObject[]) { for (const node of nodes) { if (filter && !matches(node)) continue; visibleRows.push(node); if (node.children.length && (filter || expanded.has(node.key))) collect(node.children); } }
  collect(objects);
  const mutable = !snapshot.state.viewModeEnabled && !snapshot.state.newElement;
  function select(keys: Set<string>) {
    const current = api.getSceneElements(), tree = boardObjects(current), selectedObjects = chosenObjects(tree, keys);
    const selection = objectSelection(current, selectedObjects);
    flushSync(() => {
      api.setActiveTool({ type: 'selection' });
      api.updateScene({ appState: { ...selection, editingLinearElement: null, selectedLinearElement: null, openMenu: null }, captureUpdate: CaptureUpdateAction.NEVER });
      lastSelection.current = JSON.stringify([selection.selectedElementIds, selection.selectedGroupIds]); setSelected(keys);
    });
  }
  function choose(object: BoardObject, additive = false, range = false) {
    let keys = additive ? new Set(selected) : new Set<string>();
    if (range && rangeAnchor.current) {
      const from = visibleRows.findIndex(row => row.key === rangeAnchor.current), to = visibleRows.findIndex(row => row.key === object.key);
      if (from >= 0) for (const row of visibleRows.slice(Math.min(from, to), Math.max(from, to) + 1)) keys.add(row.key);
    } else if (additive) keys = toggleObjectKey(objects, selected, object.key); else keys.add(object.key);
    rangeAnchor.current = object.key; select(keys);
  }
  function lock(items: BoardObject[], locked: boolean) {
    if (!mutable || !items.length) return;
    items = lockTargets(boardObjects(api.getSceneElements()), items, locked);
    const ids = new Set(items.flatMap(item => item.elementIds)), elements = setObjectsLocked(api.getSceneElementsIncludingDeleted(), ids, locked);
    flushSync(() => {
      api.updateScene({ elements, appState: { selectedElementIds: {}, selectedGroupIds: {}, editingLinearElement: null, selectedLinearElement: null, editingGroupId: null }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
      lastSelection.current = JSON.stringify([{}, {}]); setSelected(new Set(items.map(item => item.key)));
    });
    onMessage(`${items.length === 1 ? items[0].kind : `${items.length} objects`} ${locked ? 'locked' : 'unlocked'}.`);
  }
  function group(ungroup = false) {
    if (!mutable || chosen.some(object => object.partlyLocked) || (!ungroup && !sameParent)) return;
    select(new Set(chosen.map(object => object.key)));
    const canvas = root?.querySelector<HTMLElement>('.excalidraw'); canvas?.focus();
    canvas?.dispatchEvent(new KeyboardEvent('keydown', { key: 'g', code: 'KeyG', ctrlKey: true, metaKey: true, shiftKey: ungroup, bubbles: true, cancelable: true }));
  }
  function locate(object: BoardObject) {
    const ids = new Set(object.elementIds), elements = api.getSceneElements().filter(element => ids.has(element.id));
    if (elements.length) api.scrollToContent(elements, { fitToContent: false, animate: false });
  }
  function resize(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) return;
    resizeCleanup.current?.();
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    const start = event.clientX, width = aside.current?.getBoundingClientRect().width || preferences.width;
    const move = (input: PointerEvent) => { if (input.pointerId === event.pointerId) update({ width: Math.min(520, Math.max(240, width + start - input.clientX)) }); };
    const cleanup = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); window.removeEventListener('pointercancel', up); resizeCleanup.current = null; };
    const up = (input: PointerEvent) => { if (input.pointerId === event.pointerId) cleanup(); };
    resizeCleanup.current = cleanup;
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); window.addEventListener('pointercancel', up);
  }
  function renderRows(nodes: BoardObject[], depth = 0, inheritedLock = false, inheritedSelection = false): React.ReactNode {
    return nodes.filter(node => !filter || matches(node)).map(node => {
      const checked = inheritedSelection || selected.has(node.key), opened = !!filter || expanded.has(node.key), locked = inheritedLock || node.locked;
      return <div className="layer-branch" key={node.key}>
        <div className="layer-row" data-layer-key={node.key} data-selected={checked} data-locked={locked} style={{ '--layer-depth': depth } as CSSProperties}>
          <input type="checkbox" aria-label={`Select ${node.label}`} checked={checked} onChange={() => choose(node, true)} />
          {node.children.length ? <button className="layer-expand" aria-label={`${opened ? 'Collapse' : 'Expand'} ${node.label}`} aria-expanded={opened} onClick={() => setExpanded(previous => { const next = new Set(previous); if (next.has(node.key)) next.delete(node.key); else next.add(node.key); return next; })}>{opened ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</button> : <span className="layer-expand" />}
          <button className="layer-select" aria-label={`Select layer ${node.label}`} onClick={event => choose(node, event.ctrlKey || event.metaKey, event.shiftKey)} onDoubleClick={() => locate(node)}>
            <LayerPreview scope={scope} object={node} elements={elementsById} files={snapshot.files} dark={snapshot.state.theme === 'dark'} />
            <span className="layer-label"><strong>{node.label}</strong><small>{node.children.length ? `${node.children.length} layers` : node.kind}{locked ? ' · Locked' : node.partlyLocked ? ' · Partly locked' : ''}</small></span>
          </button>
          <button className="layer-lock" aria-label={`${locked ? 'Unlock' : 'Lock'} ${node.label}`} title={inheritedLock ? 'Unlock the parent group first' : `${locked ? 'Unlock' : 'Lock'} ${node.kind.toLowerCase()}`} disabled={!mutable || inheritedLock} onClick={() => lock([node], !locked)}>{locked ? <LockKeyhole size={15} /> : <UnlockKeyhole size={15} />}</button>
        </div>
        {node.children.length > 0 && opened && renderRows(node.children, depth + 1, locked, checked)}
      </div>;
    });
  }
  const descendants = new Set(chosen.flatMap(object => object.elementIds));
  const sameParent = chosen.length > 0 && chosen.every(object => object.parentGroupId === chosen[0].parentGroupId);
  return <>
    {host && createPortal(<button className="layers-toggle board-header-button" aria-label={preferences.open ? 'Hide layers' : 'Show layers'} aria-expanded={preferences.open} aria-controls="board-layers" onClick={() => preferences.open ? hide() : update({ open: true })}><Layers size={16} /><span>Layers</span></button>, host)}
    {preferences.open && parent && createPortal(<aside id="board-layers" className="layers-sidebar" ref={aside} aria-label="Board layers" onKeyDownCapture={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); hide(); } }} style={{ '--layers-width': `${preferences.width}px`, '--layer-tile': `${preferences.tileSize}px` } as CSSProperties}>
      <div className="layers-resize" role="separator" tabIndex={0} title="Drag the left edge to adjust width. Arrow keys also resize." aria-label="Layers sidebar width" aria-orientation="vertical" aria-valuemin={240} aria-valuemax={520} aria-valuenow={preferences.width} onPointerDown={resize} onKeyDown={event => { if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') { event.preventDefault(); update({ width: Math.max(240, Math.min(520, preferences.width + (event.key === 'ArrowLeft' ? 16 : -16))) }); } }} />
      <header className="layers-heading"><Layers size={17} /><h2>Layers</h2><span>{objects.length}</span><button aria-label="Hide layers sidebar" title="Minimize layers" onClick={hide}><Minus size={18} /></button></header>
      <label className="layers-search"><Search size={15} /><input aria-label="Find a layer" placeholder="Find an object…" value={search} onChange={event => setSearch(event.target.value)} />{search && <button aria-label="Clear layer search" onClick={() => setSearch('')}><X size={14} /></button>}</label>
      <div className="layers-options"><label>Preview size<input type="range" aria-label="Layer preview size" min="32" max="112" step="8" value={preferences.tileSize} onChange={event => update({ tileSize: Number(event.target.value) })} /></label></div>
      <p className="layers-hint">Front to back · checkboxes select several<br />Drag the left edge to adjust width</p>
      <div className="layers-list" ref={list}>{renderRows(objects)}{!visibleRows.length && <p className="layers-empty">{objects.length ? 'No matching objects.' : 'Objects you add to the board appear here.'}</p>}</div>
      <footer className="layers-footer"><div className="layers-selection-count"><span>{chosen.length ? `${chosen.length} selected` : 'No selection'}</span>{selected.size > 0 && <button onClick={() => select(new Set())}>Clear</button>}</div>
        <div className="layers-commands"><button title={!sameParent && chosen.length > 1 ? 'Select whole groups or ungroup their members before combining them.' : 'Group selected layers (Ctrl/Cmd G)'} disabled={!mutable || chosen.length < 2 || !sameParent || chosen.some(object => object.partlyLocked)} onClick={() => group()}><Group size={15} />Group</button><button disabled={!mutable || !chosen.some(object => object.groupId) || chosen.some(object => object.partlyLocked)} onClick={() => group(true)}><Ungroup size={15} />Ungroup</button>
          <button disabled={!mutable || !chosen.length || chosen.every(object => object.locked)} onClick={() => lock(chosen, true)}><LockKeyhole size={15} />Lock</button><button disabled={!mutable || !chosen.some(object => object.partlyLocked)} onClick={() => lock(chosen, false)}><UnlockKeyhole size={15} />Unlock</button>
          <button className="layers-locate" disabled={!descendants.size} onClick={() => { const elements = api.getSceneElements().filter(element => descendants.has(element.id)); api.scrollToContent(elements, { fitToContent: false, animate: false }); }}><LocateFixed size={15} />Find on board</button></div>
      </footer>
    </aside>, parent)}
  </>;
}
