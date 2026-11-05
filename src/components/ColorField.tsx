import { useEffect, useId, useState } from 'react';
import { Pipette, Slash } from 'lucide-react';
import { OBJECT_COLORS, parseObjectColor } from '../lib/object-colors';
import './object-colors.css';

export function ColorField({ label, value, onChange, noneLabel, disabled = false }: { label: string; value: string; onChange: (color: string) => void; noneLabel: string; disabled?: boolean }) {
  const id = useId(), [hex, setHex] = useState(value), [invalid, setInvalid] = useState(false);
  useEffect(() => { setHex(value); setInvalid(false); }, [value]);
  function applyHex() { const color = parseObjectColor(hex); if (color) { setInvalid(false); onChange(color); } else setInvalid(true); }
  const picker = /^#[\da-f]{6}/i.test(value) ? value.slice(0, 7) : '#7c3aed';
  return <section className="object-color-field" role="group" aria-label={`${label} colors`}>
    <div className="object-color-heading"><strong>{label}</strong><span>{value === 'mixed' ? 'Mixed' : value === 'transparent' ? 'Transparent' : value.toUpperCase()}</span></div>
    <div className="object-color-swatches">{OBJECT_COLORS.map(color => <button key={color} type="button" disabled={disabled} aria-label={`${label} ${color}`} aria-pressed={value.toLowerCase() === color} title={color.toUpperCase()} style={{ backgroundColor: color }} onClick={() => onChange(color)} />)}</div>
    <div className="object-color-custom">
      <button className="object-color-none checkerboard" type="button" disabled={disabled} aria-pressed={value === 'transparent'} onClick={() => onChange('transparent')}><Slash size={16} /><span>{noneLabel}</span></button>
      <label className="object-color-picker" htmlFor={id}><Pipette size={15} /><span>Custom</span><input id={id} aria-label={`${label} color picker`} type="color" disabled={disabled} value={picker} onChange={event => onChange(event.target.value)} /></label>
    </div>
    <div className="object-color-hex"><input aria-label={`${label} hex color`} aria-invalid={invalid} disabled={disabled} value={hex} spellCheck={false} placeholder="#RRGGBB or transparent" onChange={event => setHex(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); applyHex(); } }} /><button type="button" disabled={disabled} onClick={applyHex}>Apply</button></div>
    {invalid && <p role="alert" className="color-error">Enter a hex color such as #7C3AED, or transparent.</p>}
  </section>;
}
