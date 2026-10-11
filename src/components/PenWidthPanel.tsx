import { useLayoutEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { PenWidthControl } from './PenWidthControl';

export function PenWidthPanel({ root, enabled, value, onChange }: { root: HTMLElement | null; enabled: boolean; value: number; onChange: (value: number) => void }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  useLayoutEffect(() => {
    if (!root || !enabled) { setTarget(null); return; }
    let group: HTMLElement | null = null, slot: HTMLDivElement | null = null;
    const locate = () => {
      const next = root.querySelector<HTMLInputElement>('.excalidraw input[name="stroke-width"]')?.closest('fieldset') || null;
      if (next === group) return;
      group?.classList.remove('note-pen-width'); slot?.remove();
      group = next;
      if (group) {
        group.classList.add('note-pen-width'); slot = document.createElement('div');
        slot.className = 'note-pen-width-slot'; group.append(slot); setTarget(slot);
      } else { slot = null; setTarget(null); }
    };
    locate();
    const observer = new MutationObserver(locate); observer.observe(root, { childList: true, subtree: true });
    return () => { observer.disconnect(); group?.classList.remove('note-pen-width'); slot?.remove(); };
  }, [root, enabled]);
  return target && enabled ? createPortal(<PenWidthControl value={value} onChange={onChange} />, target) : null;
}
