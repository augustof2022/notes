import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Search, X } from 'lucide-react';
import { STAMP_ICONS, filterVectorStampIcons } from '../lib/vector-stamps';
import { Modal } from './Modal';

export interface StampPickerProps {
  selectedId: string;
  color: string;
  size: number;
  repeat: boolean;
  renderIcon: (id: string, size: number) => ReactNode;
  onChoose: (id: string) => void;
  onColorChange: (color: string) => void;
  onSizeChange: (size: number) => void;
  onRepeatChange: (repeat: boolean) => void;
  onClose: () => void;
}

const COLORS = [
  { value: '#7760d5', label: 'Purple' },
  { value: '#1971c2', label: 'Blue' },
  { value: '#2b8a3e', label: 'Green' },
  { value: '#e67700', label: 'Orange' },
  { value: '#c92a2a', label: 'Red' },
  { value: '#343a40', label: 'Charcoal' },
];

const SIZES = [32, 48, 72, 96];

function categoryLabel(value: string) {
  return value.replace(/[-_]/g, ' ').replace(/\b\w/g, character => character.toUpperCase());
}

function colorInputValue(value: string, fallback: string) {
  if (/^#[0-9a-f]{6}$/i.test(value)) return value;
  if (/^#[0-9a-f]{3}$/i.test(value)) return `#${value.slice(1).split('').map(character => character.repeat(2)).join('')}`;
  return fallback;
}

export function StampPicker(props: StampPickerProps) {
  const id = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState('all');
  const selected = STAMP_ICONS.find(icon => icon.id === props.selectedId) || STAMP_ICONS[0];
  const categories = useMemo(() => [...new Set(STAMP_ICONS.map(icon => icon.category))], []);
  const visible = filterVectorStampIcons(query, category);
  const color = colorInputValue(props.color, selected.defaultColor);
  const size = Number.isFinite(props.size) ? Math.min(160, Math.max(24, props.size)) : 48;
  useEffect(() => { searchInput.current?.focus(); }, []);

  return createPortal(<div className="icon-stamp-picker-layer">
    <Modal title="Icon stamps" wide onClose={props.onClose}>
      <div className="icon-stamp-picker">
        <p className="icon-stamp-explanation">Choose a marker, then click or tap the board to stamp. Press <kbd>I</kbd> to reuse it. <kbd>Esc</kbd> stops stamping.</p>
        <label className="vector-stamp-repeat"><input type="checkbox" checked={props.repeat} onChange={event => props.onRepeatChange(event.target.checked)} /><span>Keep stamping <small>Turn off to select each new stamp immediately for resizing.</small></span></label>

        <section className="icon-stamp-settings" aria-label="Stamp appearance">
          <div className="icon-stamp-current">
            <span className="icon-stamp-current-glyph" style={{ color }} aria-hidden="true">{props.renderIcon(selected.id, 36)}</span>
            <span><strong>{selected.label}</strong><small>{selected.description}</small></span>
          </div>
          <details className="icon-stamp-appearance-details">
            <summary>Color &amp; size <span>{size} px</span></summary>
            <div className="icon-stamp-appearance">
            <div className="icon-stamp-color-setting">
              <label htmlFor={`${id}-color`}>Stamp color</label>
              <div className="icon-stamp-colors">
                <input id={`${id}-color`} type="color" value={color} onChange={event => props.onColorChange(event.target.value)} />
                {COLORS.map(item => <button key={item.value} type="button" className="icon-stamp-color" aria-label={`${item.label} stamp color`} title={item.label} aria-pressed={color.toLowerCase() === item.value} onClick={() => props.onColorChange(item.value)}>
                  <span style={{ backgroundColor: item.value }} />
                </button>)}
              </div>
              <button type="button" className="icon-stamp-default-color" onClick={() => props.onColorChange(selected.defaultColor)}>Use icon’s default color</button>
            </div>
            <div className="icon-stamp-size-setting">
              <label htmlFor={`${id}-size`}>Stamp size <span>{size} px</span></label>
              <input id={`${id}-size`} aria-label="Stamp size" type="range" min="24" max="160" step="1" value={size} onChange={event => props.onSizeChange(Number(event.target.value))} />
              <div className="icon-stamp-sizes" role="group" aria-label="Stamp size presets">
                {SIZES.map(value => <button type="button" key={value} aria-label={`${value} pixel stamp`} aria-pressed={size === value} onClick={() => props.onSizeChange(value)}>{value}</button>)}
              </div>
            </div>
            </div>
          </details>
          <p className="icon-stamp-resize-note">You can move and resize each stamp on the board.</p>
        </section>

        <div className="icon-stamp-filters">
          <label className="icon-stamp-search" htmlFor={`${id}-search`}>
            <span className="icon-stamp-field-label">Find an icon</span>
            <span className="icon-stamp-search-input"><Search size={17} aria-hidden="true" /><input ref={searchInput} id={`${id}-search`} aria-label="Find an icon" type="search" placeholder="Clarify, research, done…" value={query} onChange={event => setQuery(event.target.value)} autoComplete="off" />
              {query && <button type="button" className="icon-button" aria-label="Clear icon search" onClick={() => setQuery('')}><X size={16} /></button>}
            </span>
          </label>
          <label className="icon-stamp-category" htmlFor={`${id}-category`}><span className="icon-stamp-field-label">Category</span>
            <select id={`${id}-category`} aria-label="Category" value={category} onChange={event => setCategory(event.target.value)}>
              <option value="all">All icons</option>
              {categories.map(value => <option key={value} value={value}>{categoryLabel(value)}</option>)}
            </select>
          </label>
        </div>

        <div className="icon-stamp-results-heading"><h3 id={`${id}-icons`}>Choose a marker</h3><span role="status" aria-live="polite">{visible.length} {visible.length === 1 ? 'icon' : 'icons'}</span></div>
        <div className="icon-stamp-grid" role="group" aria-labelledby={`${id}-icons`}>
          {visible.map(icon => <button key={icon.id} type="button" className="icon-stamp-option" aria-pressed={selected.id === icon.id} aria-label={`${icon.label}: ${icon.description}`} title={`${icon.label} — ${icon.description}`} onClick={() => props.onChoose(icon.id)}>
            <span className="icon-stamp-option-glyph" style={{ color: icon.defaultColor }} aria-hidden="true">{props.renderIcon(icon.id, 29)}</span>
            <strong>{icon.label}</strong><small>{icon.description}</small>
          </button>)}
          {!visible.length && <p className="icon-stamp-no-results">No icons found. Try another word or choose All icons.</p>}
        </div>

        <div className="dialog-actions icon-stamp-footer">
          <button type="button" className="secondary-button" onClick={props.onClose}>Cancel</button>
          <button type="button" className="primary-button" onClick={() => props.onChoose(selected.id)}><span aria-hidden="true">{props.renderIcon(selected.id, 18)}</span>Stamp {selected.label}</button>
        </div>
      </div>
    </Modal>
  </div>, document.body);
}
