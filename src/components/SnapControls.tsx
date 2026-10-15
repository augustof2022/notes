import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Grid2X2, Magnet, SlidersHorizontal } from 'lucide-react';
import { DEFAULT_GRID_SIZE, gridSize, nextSnapMode, type SnapMode } from '../lib/snapping';
import { Modal } from './Modal';

const labels = { off: 'Off', elements: 'Elements', grid: 'Grid' };
const descriptions = {
  off: 'Move freely. Tap to align with other elements.',
  elements: 'Align edges and centers with nearby elements. Tap to snap to the grid.',
  grid: 'Move and draw along the grid. Tap to turn snapping off.',
};

export function SnapControls({ mode, size, onModeChange, onSizeChange }: {
  mode: SnapMode; size: number; onModeChange: (mode: SnapMode) => void; onSizeChange: (size: number) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(String(size));
  useEffect(() => setDraft(String(size)), [size]);
  function commitSize() {
    const next = draft.trim() ? gridSize(Number(draft)) : size;
    setDraft(String(next)); onSizeChange(next);
  }
  return <>
    <button className="snap-mode-button" aria-label={`Snapping: ${labels[mode]}. Switch to ${labels[nextSnapMode(mode)].toLowerCase()}`}
      aria-pressed={mode !== 'off'} title={descriptions[mode]} onClick={() => onModeChange(nextSnapMode(mode))}>
      {mode === 'grid' ? <Grid2X2 size={15} /> : <Magnet size={15} />}<span aria-live="polite">Snap: {labels[mode]}</span>
    </button>
    <button aria-label={`Grid settings: ${size} pixels`} aria-haspopup="dialog" onClick={() => { setDraft(String(size)); setEditing(true); }} title="Adjust this board’s grid size">
      <SlidersHorizontal size={15} /><span>{size} px</span>
    </button>
    {editing && createPortal(<Modal title="Board grid" onClose={() => setEditing(false)}>
      <p className="dialog-description">Set the space between grid lines for this board. Your size is remembered in every snap mode. The grid appears when Snap: Grid is on.</p>
      <div className="grid-size-controls">
        <label>Grid size (pixels)
          <input type="number" min="1" max="100" step="1" value={draft} onChange={event => setDraft(event.target.value)} onBlur={commitSize}
            onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); commitSize(); } }} />
        </label>
        <input type="range" aria-label="Grid size slider" min="1" max="100" step="1" value={size} onChange={event => onSizeChange(Number(event.target.value))} />
        <div className="grid-size-presets" aria-label="Grid size presets">{[5, 10, 20, 40].map(value =>
          <button key={value} className="secondary-button" aria-pressed={size === value} onClick={() => onSizeChange(value)}>{value} px</button>)}
        </div>
      </div>
      <p className="small-note">1–100 pixels at 100% zoom. Smaller cells give finer placement. Changing the grid keeps existing items in place; they snap when you move them.</p>
      <div className="dialog-actions"><button className="secondary-button" onClick={() => onSizeChange(DEFAULT_GRID_SIZE)}>Reset to 20 px</button><button className="primary-button" onClick={() => setEditing(false)}>Done</button></div>
    </Modal>, document.body)}
  </>;
}
