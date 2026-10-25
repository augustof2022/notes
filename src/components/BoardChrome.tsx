import { forwardRef, useImperativeHandle, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, EyeOff, Maximize2, Minus } from 'lucide-react';
import { BOARD_CHROME_DEFAULTS, readBoardChrome, saveBoardChrome, type BoardChromeGroup } from '../lib/board-chrome';
import { Modal } from './Modal';
import './board-chrome.css';

export interface BoardChromeHandle { open: () => void; toggle: () => void }

const groups: { key: BoardChromeGroup; title: string; description: string }[] = [
  { key: 'actions', title: 'Board actions', description: 'Zoom lock, read text, diagrams, snapping, icon stamps, and writing tools.' },
  { key: 'drawing', title: 'Drawing tools', description: 'Select, draw, add text and images, and choose shapes. Includes pan and tool lock on desktop.' },
  { key: 'navigation', title: 'Navigation tools', description: 'Library and zoom controls. Includes pan and tool lock on smaller screens.' },
  { key: 'editing', title: 'Editing tools', description: 'Object properties, board menus, and undo and redo.' },
];

export const BoardChrome = forwardRef<BoardChromeHandle, { root: HTMLElement | null }>(function BoardChrome({ root }, ref) {
  const [opened, setOpened] = useState(false);
  const [visibility, setVisibility] = useState(readBoardChrome);
  const [host, setHost] = useState<Element | null>(null);
  const [editor, setEditor] = useState<Element | null>(null);
  const [slots, setSlots] = useState<Partial<Record<BoardChromeGroup, HTMLElement>>>({});
  const anyVisible = Object.values(visibility).some(Boolean);
  useImperativeHandle(ref, () => ({ open: () => setOpened(true), toggle: () => setOpened(value => !value) }), []);
  useLayoutEffect(() => { setHost(root?.closest('.main-content')?.querySelector('.board-chrome-quick-slot') || null); }, [root]);

  useLayoutEffect(() => {
    if (!root) return;
    const attached = new Map<BoardChromeGroup, { target: Element; slot: HTMLElement }>();
    const locate = () => {
      const canvas = root.querySelector('.excalidraw');
      setEditor(previous => previous === canvas ? previous : canvas);
      const mobile = canvas?.classList.contains('excalidraw--mobile');
      const library = canvas?.querySelector('.default-sidebar-trigger')?.closest('.sidebar-trigger__label-element');
      const targets: Record<BoardChromeGroup, Element | null | undefined> = {
        actions: null,
        drawing: null,
        navigation: mobile ? canvas?.querySelector('.mobile-misc-tools-container') : library?.parentElement,
        editing: canvas?.querySelector(mobile ? '.App-bottom-bar .App-toolbar-content' : '.undo-redo-buttons'),
      };
      let changed = false;
      for (const { key } of groups) {
        const previous = attached.get(key), target = targets[key];
        if (!previous && !target) continue;
        if (previous && previous.target === target && previous.slot.parentElement === target) continue;
        previous?.slot.remove(); if (key === 'navigation') previous?.target.classList.remove('note-toolbar-navigation-host');
        attached.delete(key); changed = true;
        if (!target) continue;
        const slot = document.createElement('div');
        slot.className = 'note-toolbar-minimize-slot'; slot.dataset.toolbarGroup = key;
        slot.dataset.layout = mobile ? 'mobile' : 'desktop';
        if (key === 'navigation') target.classList.add('note-toolbar-navigation-host');
        if (key === 'drawing' || (key === 'navigation' && mobile)) target.prepend(slot); else target.append(slot);
        attached.set(key, { target, slot });
      }
      if (changed) setSlots(Object.fromEntries([...attached].map(([key, { slot }]) => [key, slot])));
    };
    locate();
    const observer = new MutationObserver(locate);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    return () => { observer.disconnect(); for (const [key, { slot, target }] of attached) { slot.remove(); if (key === 'navigation') target.classList.remove('note-toolbar-navigation-host'); } };
  }, [root]);

  useLayoutEffect(() => {
    if (!root) return;
    const previous = groups.map(({ key }) => [key, root.getAttribute(`data-chrome-${key}`)] as const);
    for (const { key } of groups) root.setAttribute(`data-chrome-${key}`, String(visibility[key]));
    return () => {
      for (const [key, value] of previous) {
        if (value === null) root.removeAttribute(`data-chrome-${key}`);
        else root.setAttribute(`data-chrome-${key}`, value);
      }
    };
  }, [root, visibility]);

  useLayoutEffect(() => {
    if (!root) return;
    const change = (event: Event) => {
      const detail = (event as CustomEvent).detail;
      if (detail && (detail.group === 'actions' || detail.group === 'drawing') && typeof detail.visible === 'boolean') toggleGroup(detail.group, detail.visible);
    };
    root.addEventListener('note:toolbar-visibility', change);
    return () => root.removeEventListener('note:toolbar-visibility', change);
  }, [root]);

  function update(next: typeof visibility) { setVisibility(next); saveBoardChrome(next); }
  function toggleGroup(key: BoardChromeGroup, visible: boolean) {
    setVisibility(previous => { const next = { ...previous, [key]: visible }; saveBoardChrome(next); return next; });
    requestAnimationFrame(() => root?.querySelector<HTMLButtonElement>(visible
      ? key === 'actions' || key === 'drawing' ? `.floating-toolbar-${key} .floating-toolbar-minimize` : `.note-toolbar-minimize-slot[data-toolbar-group="${key}"] button`
      : key === 'actions' || key === 'drawing' ? `.floating-toolbar-restore-${key} button` : `.note-toolbar-restore[data-toolbar-group="${key}"] button`)?.focus({ preventScroll: true }));
  }
  return <>
    {groups.map(({ key, title }) => slots[key] && createPortal(<div className="note-toolbar-minimize-control">
      {key === 'drawing' && <span>{title}</span>}
      <button type="button" className="note-toolbar-minimize-button" aria-label={`Minimize ${title.toLowerCase()}`} title={`Minimize ${title.toLowerCase()}`} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); toggleGroup(key, false); }}><Minus size={17} /></button>
    </div>, slots[key]!, key))}
    {groups.filter(({ key }) => key === 'navigation' || key === 'editing').map(({ key, title }) => !visibility[key] && editor && createPortal(<div className={`note-toolbar-restore note-toolbar-restore-${key}`} data-toolbar-group={key}>
      <button type="button" aria-label={`Restore ${title.toLowerCase()}`} title={`Restore ${title.toLowerCase()}`} onPointerDown={event => event.stopPropagation()} onClick={event => { event.stopPropagation(); toggleGroup(key, true); }}><Maximize2 size={14} /><span>{title}</span></button>
    </div>, editor!, `restore-${key}`))}
    {host && createPortal(<button className="board-chrome-quick-toggle" aria-label={anyVisible ? 'Hide all board toolbars' : 'Show all board toolbars'} title={anyVisible ? 'Minimize all four board toolbars' : 'Restore all four board toolbars'} onClick={() => update(anyVisible ? { actions: false, drawing: false, navigation: false, editing: false } : { ...BOARD_CHROME_DEFAULTS })}>
      {anyVisible ? <EyeOff size={16} /> : <Eye size={16} />}<span>{anyVisible ? 'Hide tools' : 'Show tools'}</span>
    </button>, host)}
    {opened && createPortal(<Modal title="Board toolbars" onClose={() => setOpened(false)}>
    <p className="dialog-description">Each toolbar has a minus button to minimize it and a labeled tab to restore it. Use Hide tools or Show tools in the header for all four together. This menu stays available with the sidebar hidden. Drag the grip on Board actions or Drawing tools to move it, or drag its right edge to resize it. Use ⋮ More to arrange controls. Your layout is remembered on this browser.</p>
    <div className="board-chrome-options">{groups.map(({ key, title, description }) => <label key={key}>
      <input type="checkbox" checked={visibility[key]} onChange={event => update({ ...visibility, [key]: event.target.checked })} />
      <span><strong>{title}</strong><small>{description}</small></span>
    </label>)}</div>
    <div className="board-chrome-presets"><button className="secondary-button" onClick={() => update({ ...BOARD_CHROME_DEFAULTS })}>Show all</button>
      <button className="secondary-button" onClick={() => update({ actions: false, drawing: false, navigation: false, editing: false })}>Hide all</button><button className="secondary-button" onClick={() => root?.dispatchEvent(new Event('note:toolbar-reset'))}>Reset toolbar layouts</button></div>
    <div className="dialog-actions"><button className="primary-button" onClick={() => setOpened(false)}>Done</button></div>
  </Modal>, document.body)}
  </>;
});
