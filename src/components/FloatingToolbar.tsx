import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, GripVertical, Maximize2, Minus, MoreVertical, RotateCcw, Settings2 } from 'lucide-react';
import { moveToolbarItem, readToolbarLayout, saveToolbarLayout, toolbarBounds, toolbarDefaults, visibleToolbarItems, TOOLBAR_MIN_WIDTH, type FloatingToolbarGroup, type ToolbarLayout } from '../lib/toolbar-layout';
import { Modal } from './Modal';
import './floating-toolbar.css';

export interface ToolbarItem { id: string; title: string; content?: ReactNode }
export function FloatingToolbar({ group, title, root, items }: { group: FloatingToolbarGroup; title: string; root: HTMLElement | null; items: ToolbarItem[] }) {
  const ids = items.map(item => item.id);
  const [layout, setLayout] = useState(() => readToolbarLayout(group, ids));
  const [board, setBoard] = useState({ width: 800, height: 600, mobile: false });
  const [more, setMore] = useState(false), [arranging, setArranging] = useState(false);
  const [activeIds, setActiveIds] = useState<string[]>([]), [visibleCount, setVisibleCount] = useState(0);
  const bar = useRef<HTMLDivElement>(null), row = useRef<HTMLDivElement>(null), overflow = useRef<HTMLDivElement>(null), panel = useRef<HTMLDivElement>(null);
  const measuring = useRef<HTMLDivElement>(null), moreButton = useRef<HTMLButtonElement>(null);
  // These containers belong to this component. Moving them preserves the portals
  // and their state without moving DOM nodes owned by another React component.
  const [slots] = useState(() => Object.fromEntries(ids.map(id => {
    const slot = document.createElement('div'); slot.className = 'floating-toolbar-item'; slot.dataset.toolbarSlot = `${group}-${id}`;
    return [id, slot];
  })));
  const live = useRef(layout); live.current = layout;
  const bounds = toolbarBounds(layout, group, board);
  function update(next: ToolbarLayout) { live.current = next; setLayout(next); saveToolbarLayout(group, next); }
  function visibility(visible: boolean) {
    setMore(false); root?.dispatchEvent(new CustomEvent('note:toolbar-visibility', { detail: { group, visible } }));
  }
  function reset() { update(toolbarDefaults(group, ids)); setMore(false); }
  useLayoutEffect(() => {
    if (!root) return;
    const resize = () => setBoard({ width: root.clientWidth, height: root.clientHeight, mobile: !!root.querySelector('.excalidraw--mobile') });
    resize(); const observer = new ResizeObserver(resize); observer.observe(root);
    const mutations = new MutationObserver(resize); mutations.observe(root.querySelector('.excalidraw') || root, { attributes: true, attributeFilter: ['class'] });
    const onReset = () => reset(); root.addEventListener('note:toolbar-reset', onReset);
    return () => { observer.disconnect(); mutations.disconnect(); root.removeEventListener('note:toolbar-reset', onReset); };
  }, [root]);
  useLayoutEffect(() => {
    let frame = 0;
    const measure = () => {
      frame = 0;
      if (!row.current || !overflow.current || !measuring.current || !bar.current?.offsetWidth) return;
      const active = layout.order.filter(id => slots[id]?.childElementCount);
      const widths = active.map(id => {
        const clone = slots[id].cloneNode(true) as HTMLElement;
        clone.removeAttribute('data-toolbar-slot');
        measuring.current!.append(clone); const width = clone.getBoundingClientRect().width; clone.remove(); return Math.ceil(width);
      });
      const count = visibleToolbarItems(widths, Math.max(0, bounds.width - 116));
      active.forEach((id, index) => {
        const target = index < count ? row.current! : overflow.current!;
        // append in the saved order, but never mutate a portal's React children.
        if (slots[id].parentElement !== target || target.children[index < count ? index : index - count] !== slots[id]) target.insertBefore(slots[id], target.children[index < count ? index : index - count] || null);
      });
      for (const id of layout.order) if (!active.includes(id) && slots[id].parentElement !== overflow.current) overflow.current.append(slots[id]);
      setActiveIds(previous => previous.join() === active.join() ? previous : active);
      setVisibleCount(previous => previous === count ? previous : count);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    const mutations = new MutationObserver(schedule);
    for (const slot of Object.values(slots)) {
      if (!slot.parentElement) overflow.current?.append(slot);
      mutations.observe(slot, { childList: true, subtree: true, characterData: true, attributes: true });
    }
    const resize = new ResizeObserver(schedule); if (bar.current) resize.observe(bar.current);
    const visibility = new MutationObserver(() => {
      if (root?.getAttribute(`data-chrome-${group}`) === 'false') setMore(false);
      schedule();
    });
    if (root) visibility.observe(root, { attributes: true, attributeFilter: [`data-chrome-${group}`] });
    measure(); document.fonts.ready.then(schedule);
    return () => { mutations.disconnect(); resize.disconnect(); visibility.disconnect(); cancelAnimationFrame(frame); };
  }, [layout.order, layout.labels, bounds.width, slots, root, group]);
  useLayoutEffect(() => {
    if (!panel.current) return;
    panel.current.inert = !more;
    if (more && root) {
      const rect = bar.current!.getBoundingClientRect(), boardRect = root.getBoundingClientRect();
      const below = boardRect.bottom - rect.bottom - 8, above = rect.top - boardRect.top - 8;
      const down = below >= Math.min(380, above);
      panel.current.style.maxHeight = `${Math.max(0, down ? below : above)}px`;
      panel.current.dataset.direction = down ? 'down' : 'up';
      const panelWidth = Math.min(280, board.width - 16);
      const left = Math.max(8, Math.min(bounds.x + bounds.width - panelWidth, board.width - panelWidth - 8));
      panel.current.style.width = `${panelWidth}px`;
      panel.current.style.left = `${left - bounds.x}px`;
      panel.current.style.right = 'auto';
    }
  }, [more, bounds.x, bounds.y, board]);
  useEffect(() => {
    const target = overflow.current;
    const close = (event: MouseEvent) => { if ((event.target as Element).closest('button')) setMore(false); };
    target?.addEventListener('click', close);
    return () => target?.removeEventListener('click', close);
  }, []);
  useEffect(() => {
    if (!more) return;
    const outside = (event: PointerEvent) => { if (!bar.current?.contains(event.target as Node)) setMore(false); };
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setMore(false); moreButton.current?.focus(); }
    };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key, true);
    requestAnimationFrame(() => panel.current?.querySelector<HTMLElement>('button,input')?.focus());
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key, true); };
  }, [more]);
  function start(event: ReactPointerEvent<HTMLButtonElement>, kind: 'move' | 'resize') {
    if (event.button !== 0) return;
    event.preventDefault(); setMore(false);
    event.currentTarget.setPointerCapture(event.pointerId);
    const initial = { ...bounds }, origin = { x: event.clientX, y: event.clientY }, target = event.currentTarget;
    const move = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      const dx = next.clientX - origin.x, dy = next.clientY - origin.y;
      const nextLayout = kind === 'move'
        ? { ...live.current, x: Math.max(8, Math.min(initial.x + dx, board.width - initial.width - 8)), y: Math.max(8, Math.min(initial.y + dy, board.height - 56)) }
        : { ...live.current, x: initial.x, width: Math.max(Math.min(TOOLBAR_MIN_WIDTH, board.width - 16), Math.min(initial.width + dx, board.width - initial.x - 8)) };
      // Persist only when the gesture ends, rather than on every pointer movement.
      live.current = nextLayout; setLayout(nextLayout);
    };
    const end = (next: PointerEvent) => {
      if (next.pointerId !== event.pointerId) return;
      target.removeEventListener('pointermove', move); target.removeEventListener('pointerup', end); target.removeEventListener('pointercancel', end);
      saveToolbarLayout(group, live.current);
    };
    target.addEventListener('pointermove', move); target.addEventListener('pointerup', end); target.addEventListener('pointercancel', end);
  }
  function moveKey(event: React.KeyboardEvent, resize: boolean) {
    const delta = event.shiftKey ? 40 : 10;
    const directions: Record<string, [number, number]> = { ArrowLeft: [-delta, 0], ArrowRight: [delta, 0], ArrowUp: [0, -delta], ArrowDown: [0, delta] };
    const direction = directions[event.key]; if (!direction) return;
    event.preventDefault(); event.stopPropagation();
    if (resize) update({ ...layout, x: bounds.x, width: Math.max(TOOLBAR_MIN_WIDTH, Math.min(bounds.width + direction[0], board.width - bounds.x - 8)) });
    else update({ ...layout, x: Math.max(8, Math.min(bounds.x + direction[0], board.width - bounds.width - 8)), y: Math.max(8, Math.min(bounds.y + direction[1], board.height - 56)) });
  }
  const hiddenCount = activeIds.length - visibleCount;
  return <>
    <div ref={bar} className={`floating-toolbar floating-toolbar-${group}`} data-labels={layout.labels} role="group" aria-label={title}
      style={{ left: bounds.x, top: bounds.y, width: bounds.width }} onPointerDown={event => event.stopPropagation()} onKeyDown={event => { if (event.target instanceof HTMLElement && !event.target.closest('.floating-toolbar-item')) event.stopPropagation(); }}>
      <button className="floating-toolbar-grip" aria-label={`Move ${title.toLowerCase()}`} title="Drag to move. Arrow keys move; Shift moves farther." onPointerDown={event => start(event, 'move')} onKeyDown={event => moveKey(event, false)}><GripVertical size={17} /></button>
      <div ref={row} className={`floating-toolbar-items ${group === 'actions' ? 'canvas-tools' : ''}`} />
      <button ref={moreButton} className="floating-toolbar-more" aria-label={`More ${title.toLowerCase()}`} title={hiddenCount ? `${hiddenCount} more controls and toolbar settings` : 'Toolbar settings'} aria-expanded={more} aria-haspopup="dialog" onClick={() => setMore(value => !value)}><MoreVertical size={18} />{hiddenCount > 0 && <small>{hiddenCount}</small>}</button>
      <button className="floating-toolbar-minimize" aria-label={`Minimize ${title.toLowerCase()}`} title={`Minimize ${title.toLowerCase()}`} onClick={() => visibility(false)}><Minus size={17} /></button>
      <button className="floating-toolbar-resize" aria-label={`Resize ${title.toLowerCase()}`} title="Drag to adjust width. Left and right arrow keys also resize." onPointerDown={event => start(event, 'resize')} onKeyDown={event => moveKey(event, true)}><span /></button>
      <div ref={measuring} className="floating-toolbar-measure floating-toolbar-items" aria-hidden="true" inert />
      <div ref={panel} className="floating-toolbar-popover" role="dialog" aria-label={`${title} options`} data-open={more}>
        <div ref={overflow} className="floating-toolbar-overflow" onClick={event => { if ((event.target as Element).closest('button')) setMore(false); }} />
        {hiddenCount > 0 && <hr />}
        <button className="floating-toolbar-setting" onClick={() => { setMore(false); setArranging(true); }}><Settings2 size={16} /><span>Arrange controls</span></button>
        <label className="floating-toolbar-width">Width <output>{Math.round(bounds.width)} px</output><input type="range" aria-label={`${title} width`} min={Math.min(TOOLBAR_MIN_WIDTH, board.width - 16)} max={Math.max(TOOLBAR_MIN_WIDTH, board.width - bounds.x - 8)} value={bounds.width} onChange={event => update({ ...layout, x: bounds.x, width: Number(event.target.value) })} /></label>
        <label className="floating-toolbar-labels"><input type="checkbox" checked={layout.labels} onChange={event => update({ ...layout, labels: event.target.checked })} />Show button labels</label>
        <button className="floating-toolbar-setting" onClick={reset}><RotateCcw size={16} /><span>Reset this toolbar</span></button>
      </div>
    </div>
    <div className={`floating-toolbar-restore floating-toolbar-restore-${group}`} style={{ left: Math.min(bounds.x, Math.max(8, board.width - 160)), top: bounds.y }}>
      <button aria-label={`Restore ${title.toLowerCase()}`} onClick={() => visibility(true)}><Maximize2 size={15} />{title}</button>
    </div>
    {items.map(item => item.content !== undefined && createPortal(item.content, slots[item.id], item.id))}
    {arranging && createPortal(<Modal title={`Arrange ${title.toLowerCase()}`} onClose={() => setArranging(false)}>
      <p className="dialog-description">Move controls up or down to change their left-to-right order. Controls that do not fit stay available in ⋮ More.</p>
      <div className="toolbar-order-list">{layout.order.map((id, index) => <div key={id}><span>{items.find(item => item.id === id)?.title}</span>
        <button aria-label={`Move ${items.find(item => item.id === id)?.title} earlier`} disabled={index === 0} onClick={() => update({ ...layout, order: moveToolbarItem(layout.order, id, -1) })}><ArrowUp size={17} /></button>
        <button aria-label={`Move ${items.find(item => item.id === id)?.title} later`} disabled={index === layout.order.length - 1} onClick={() => update({ ...layout, order: moveToolbarItem(layout.order, id, 1) })}><ArrowDown size={17} /></button>
      </div>)}</div>
      <div className="dialog-actions"><button className="secondary-button" onClick={() => update({ ...layout, order: [...ids] })}>Reset order</button><button className="primary-button" onClick={() => setArranging(false)}>Done</button></div>
    </Modal>, document.body)}
  </>;
}
