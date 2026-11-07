import { forwardRef, useImperativeHandle, useLayoutEffect, useState } from 'react';
import { Eye } from 'lucide-react';
import { readToolbarsHidden, saveToolbarsHidden } from '../lib/board-chrome';

export interface BoardChromeHandle { toggle: () => void; hidden: () => boolean }

/** Hide every board toolbar for a clean canvas; one button brings them back. */
export const BoardChrome = forwardRef<BoardChromeHandle, { root: HTMLElement | null }>(function BoardChrome({ root }, ref) {
  const [hidden, setHidden] = useState(readToolbarsHidden);
  function update(next: boolean) {
    setHidden(next); saveToolbarsHidden(next);
    if (!next) requestAnimationFrame(() => root?.querySelector<HTMLElement>('.note-toolbar .note-tool')?.focus({ preventScroll: true }));
  }
  useImperativeHandle(ref, () => ({ toggle: () => update(!hidden), hidden: () => hidden }), [hidden, root]);
  useLayoutEffect(() => {
    if (!root) return;
    root.setAttribute('data-toolbars', hidden ? 'hidden' : 'shown');
    return () => root.removeAttribute('data-toolbars');
  }, [root, hidden]);
  useLayoutEffect(() => {
    const hide = () => update(true);
    root?.addEventListener('note-hide-toolbars', hide);
    return () => root?.removeEventListener('note-hide-toolbars', hide);
  }, [root, hidden]);
  return hidden ? <button type="button" className="note-toolbars-restore" onClick={() => update(false)} title="Show the board toolbars again"><Eye size={16} /><span>Show toolbars</span></button> : null;
});
