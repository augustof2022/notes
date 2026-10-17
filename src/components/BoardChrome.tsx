import { forwardRef, useImperativeHandle, useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { BOARD_CHROME_DEFAULTS, readBoardChrome, saveBoardChrome, type BoardChromeGroup } from '../lib/board-chrome';
import { Modal } from './Modal';
import './board-chrome.css';

export interface BoardChromeHandle { open: () => void; toggle: () => void }

const groups: { key: BoardChromeGroup; title: string; description: string }[] = [
  { key: 'actions', title: 'Board actions', description: 'Zoom lock, read text, diagrams, and snapping.' },
  { key: 'drawing', title: 'Drawing tools', description: 'Select, draw, add text and images, and choose shapes.' },
  { key: 'navigation', title: 'Navigation tools', description: 'Library, tool lock, pan, and zoom controls.' },
  { key: 'editing', title: 'Editing tools', description: 'Object properties, board menus, and undo and redo.' },
];

export const BoardChrome = forwardRef<BoardChromeHandle, { root: HTMLElement | null }>(function BoardChrome({ root }, ref) {
  const [opened, setOpened] = useState(false);
  const [visibility, setVisibility] = useState(readBoardChrome);
  useImperativeHandle(ref, () => ({ open: () => setOpened(true), toggle: () => setOpened(value => !value) }), []);

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

  function update(next: typeof visibility) { setVisibility(next); saveBoardChrome(next); }
  return opened ? createPortal(<Modal title="Board toolbars" onClose={() => setOpened(false)}>
    <p className="dialog-description">Choose which controls to show. Open this menu from the board header to bring them back. Your layout is remembered on this browser.</p>
    <div className="board-chrome-options">{groups.map(({ key, title, description }) => <label key={key}>
      <input type="checkbox" checked={visibility[key]} onChange={event => update({ ...visibility, [key]: event.target.checked })} />
      <span><strong>{title}</strong><small>{description}</small></span>
    </label>)}</div>
    <div className="board-chrome-presets"><button className="secondary-button" onClick={() => update({ ...BOARD_CHROME_DEFAULTS })}>Show all</button>
      <button className="secondary-button" onClick={() => update({ actions: false, drawing: false, navigation: false, editing: false })}>Hide all</button></div>
    <div className="dialog-actions"><button className="primary-button" onClick={() => setOpened(false)}>Done</button></div>
  </Modal>, document.body) : null;
});
