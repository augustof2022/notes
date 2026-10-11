import { useEffect, useState } from 'react';
import { DEFAULT_PEN_WIDTH, penWidth } from '../lib/canvas-behavior';
export function PenWidthControl({ value, onChange }: { value: number; onChange: (value: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);
  function commit() {
    if (draft.trim() && Number.isFinite(Number(draft))) {
      const next = penWidth(Number(draft));
      setDraft(String(next));
      onChange(next);
    } else setDraft(String(value));
  }
  return <div className="pen-width-control"><span>Pen width</span><input type="range" aria-label="Pen width slider" min="0.5" max="12" step="0.5" value={value} onChange={event => onChange(Number(event.target.value))} />
    <input type="number" aria-label="Pen width value" min="0.5" max="12" step="0.5" value={draft} onChange={event => setDraft(event.target.value)} onBlur={commit} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); } }} />
    <button onClick={() => onChange(DEFAULT_PEN_WIDTH)} title="Writing default: 1">Default</button></div>;
}
