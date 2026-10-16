import { useId, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { GitBranch, Link2, Plus, Shapes, Type } from 'lucide-react';
import { DIAGRAM_SYSTEMS, DIAGRAM_THEMES, type DiagramSide, type DiagramSystemId } from '../lib/diagram-model';
import { Modal } from './Modal';

export type DiagramStyle = {
  fill: string;
  stroke: string;
  width: number;
  strokeStyle: 'solid' | 'dashed' | 'dotted';
};

export type ConnectionSettings = {
  fromSide: DiagramSide;
  toSide: DiagramSide;
  route: 'straight' | 'elbow' | 'curved';
  startArrowhead: string | null;
  endArrowhead: string | null;
  doubleLine: boolean;
};

export type DiagramPanelProps = {
  system: DiagramSystemId;
  presetId: string;
  onSystemChange: (system: DiagramSystemId) => void;
  onPresetChange: (presetId: string) => void;
  onAddShape: () => void;
  selectedNode: { id: string; label: string; parentId?: string | null } | null;
  selectedEdge: boolean;
  onAddSibling: () => void;
  onAddChild: () => void;
  onConnect: () => void;
  onEditLabel: () => void;
  connecting: boolean;
  onCancelConnection: () => void;
  connection: ConnectionSettings;
  onConnectionChange: (changes: Partial<ConnectionSettings>) => void;
  style: DiagramStyle;
  onStyleChange: (changes: Partial<DiagramStyle>) => void;
  onTheme: (themeId: string) => void;
  onClose: () => void;
  onExit: () => void;
};

const SIDES: { value: DiagramSide; label: string }[] = [
  { value: 'top', label: 'Top' },
  { value: 'right', label: 'Right' },
  { value: 'bottom', label: 'Bottom' },
  { value: 'left', label: 'Left' },
];

const MARKERS = [
  { value: '', label: 'None' },
  { value: 'arrow', label: 'Arrow' },
  { value: 'bar', label: 'One (bar)' },
  { value: 'crowfoot_one', label: 'Exactly one' },
  { value: 'crowfoot_many', label: 'Many (crow’s foot)' },
  { value: 'crowfoot_one_or_many', label: 'One or many' },
];

function ShapePreview({ type, doubleOutline }: { type: string; doubleOutline?: boolean }) {
  const shape = type === 'ellipse'
    ? <ellipse cx="28" cy="21" rx="23" ry="15" />
    : type === 'diamond'
      ? <path d="M28 3 53 21 28 39 3 21Z" />
      : <rect x="5" y="6" width="46" height="30" rx={type === 'rectangle' ? 2 : 10} />;
  const inner = type === 'ellipse'
    ? <ellipse cx="28" cy="21" rx="19" ry="11" />
    : type === 'diamond'
      ? <path d="M28 8 47 21 28 34 9 21Z" />
      : <rect x="9" y="10" width="38" height="22" rx="1" />;
  return <svg className="diagram-shape-preview" width="56" height="42" viewBox="0 0 56 42" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.6">
    {shape}{doubleOutline && inner}
    {type === 'rectangle' && <path d="M17 18h22M17 24h16" opacity=".45" />}
  </svg>;
}

function colorInputValue(value: string, fallback: string) {
  return /^#[0-9a-f]{6}$/i.test(value) ? value : fallback;
}

export function DiagramPanel(props: DiagramPanelProps) {
  const id = useId();
  const system = DIAGRAM_SYSTEMS.find(item => item.id === props.system) || DIAGRAM_SYSTEMS[0];
  const selectedPreset = system.presets.find(item => item.id === props.presetId) || system.presets[0];
  const selection = props.selectedEdge ? 'Selected connection' : props.selectedNode ? 'Selected shape' : 'New shapes and connections';
  const connectionControls = <div className="diagram-field-grid">
    <label className="diagram-field" htmlFor={`${id}-from-side`}>
      <span>From side</span>
      <select id={`${id}-from-side`} aria-label="From side" value={props.connection.fromSide} onChange={event => props.onConnectionChange({ fromSide: event.target.value as DiagramSide })}>
        {SIDES.map(side => <option key={side.value} value={side.value}>{side.label}</option>)}
      </select>
    </label>
    <label className="diagram-field" htmlFor={`${id}-to-side`}>
      <span>To side</span>
      <select id={`${id}-to-side`} aria-label="To side" value={props.connection.toSide} onChange={event => props.onConnectionChange({ toSide: event.target.value as DiagramSide })}>
        {SIDES.map(side => <option key={side.value} value={side.value}>{side.label}</option>)}
      </select>
    </label>
    <label className="diagram-field diagram-field-full" htmlFor={`${id}-route`}>
      <span>Connection route</span>
      <select id={`${id}-route`} aria-label="Connection route" value={props.connection.route} onChange={event => props.onConnectionChange({ route: event.target.value as ConnectionSettings['route'] })}>
        <option value="straight">Straight</option>
        <option value="elbow">Right-angle / elbow</option>
        <option value="curved">Curved</option>
      </select>
    </label>
    <label className="diagram-field" htmlFor={`${id}-start-marker`}>
      <span>Start marker</span>
      <select id={`${id}-start-marker`} aria-label="Start marker" value={props.connection.startArrowhead || ''} onChange={event => props.onConnectionChange({ startArrowhead: event.target.value || null })}>
        {MARKERS.map(marker => <option key={marker.value} value={marker.value}>{marker.label}</option>)}
      </select>
    </label>
    <label className="diagram-field" htmlFor={`${id}-end-marker`}>
      <span>End marker</span>
      <select id={`${id}-end-marker`} aria-label="End marker" value={props.connection.endArrowhead || ''} onChange={event => props.onConnectionChange({ endArrowhead: event.target.value || null })}>
        {MARKERS.map(marker => <option key={marker.value} value={marker.value}>{marker.label}</option>)}
      </select>
    </label>
    <label className="diagram-checkbox diagram-field-full" htmlFor={`${id}-double-line`}>
      <input id={`${id}-double-line`} aria-label="Double connection line" type="checkbox" checked={props.connection.doubleLine} onChange={event => props.onConnectionChange({ doubleLine: event.target.checked })} />
      <span>Double connection line</span>
    </label>
  </div>;

  return createPortal(<div className="diagram-panel-layer">
    <Modal title="Diagram tools" wide onClose={props.onClose}>
      <div className="diagram-panel">
        {props.connecting && <div className="diagram-connection-notice" role="status">
          <Link2 size={18} aria-hidden="true" />
          <p>Choose a target shape on the board to finish this connection.</p>
          <button type="button" onClick={props.onCancelConnection}>Cancel connection</button>
        </div>}

        {props.selectedNode && !props.selectedEdge && <section className="diagram-selection" aria-labelledby={`${id}-selection`}>
          <div className="diagram-section-heading">
            <h3 id={`${id}-selection`}>Selected shape</h3>
            <span className="diagram-selected-label" title={props.selectedNode.label}>{props.selectedNode.label || 'Untitled shape'}</span>
          </div>
          <div className="diagram-node-actions">
            <button type="button" onClick={props.onAddSibling}><Plus size={17} aria-hidden="true" />Add sibling</button>
            <button type="button" onClick={props.onAddChild}><GitBranch size={17} aria-hidden="true" />Add child</button>
            <button type="button" onClick={props.onConnect}><Link2 size={17} aria-hidden="true" />Add connection</button>
            <button type="button" onClick={props.onEditLabel}><Type size={17} aria-hidden="true" />Edit text</button>
          </div>
          <p className="diagram-help">A child goes under this shape. A sibling shares its parent and sits alongside it.</p>
        </section>}

        <section className="diagram-palette" aria-labelledby={`${id}-palette`}>
          <div className="diagram-section-heading"><h3 id={`${id}-palette`}><Shapes size={17} aria-hidden="true" />Shape library</h3></div>
          <label className="diagram-field" htmlFor={`${id}-system`}>
            <span>Diagram system</span>
            <select id={`${id}-system`} aria-label="Diagram system" value={props.system} onChange={event => props.onSystemChange(event.target.value as DiagramSystemId)}>
              {DIAGRAM_SYSTEMS.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
            </select>
          </label>
          <p className="diagram-help">{system.description}</p>
          <div className="diagram-presets" role="group" aria-label={`${system.label} shapes`}>
            {system.presets.map(preset => <button type="button" key={preset.id} className="diagram-preset" aria-pressed={props.presetId === preset.id} onClick={() => props.onPresetChange(preset.id)}>
              <ShapePreview type={preset.type} doubleOutline={preset.doubleOutline} />
              <span>{preset.label}</span>
            </button>)}
          </div>
          <button type="button" className="primary-button diagram-add-shape" onClick={props.onAddShape}><Plus size={18} aria-hidden="true" />Add {selectedPreset?.label || 'shape'}</button>
          <p className="diagram-help">Add a shape, then type its text. Move and resize it directly on the board.</p>
        </section>

        <details className="diagram-details" open={!!props.selectedEdge || props.connecting}>
          <summary>Connections <span>{props.selectedEdge ? 'Selected connection' : 'New connection defaults'}</span></summary>
          <div className="diagram-details-content">
            {connectionControls}
            <p className="diagram-help">Connections stay attached when their shapes move. Double-click a connection on the board to edit its points.</p>
          </div>
        </details>

        <details className="diagram-details" open={!!props.selectedNode || props.selectedEdge}>
          <summary>Colors &amp; lines <span>{selection}</span></summary>
          <div className="diagram-details-content">
            <div className="diagram-field-grid">
              {!props.selectedEdge && <div className="diagram-field">
                <label htmlFor={`${id}-fill`}>Shape fill</label>
                <div className="diagram-color-field">
                  <input id={`${id}-fill`} aria-label="Shape fill" type="color" value={colorInputValue(props.style.fill, '#ffffff')} onChange={event => props.onStyleChange({ fill: event.target.value })} />
                  <button type="button" aria-pressed={props.style.fill === 'transparent'} onClick={() => props.onStyleChange({ fill: 'transparent' })}>No fill</button>
                </div>
              </div>}
              <label className="diagram-field" htmlFor={`${id}-stroke`}>
                <span>{props.selectedEdge ? 'Line color' : 'Border / line color'}</span>
                <div className="diagram-color-field">
                  <input id={`${id}-stroke`} aria-label={props.selectedEdge ? 'Line color' : 'Border / line color'} type="color" value={colorInputValue(props.style.stroke, '#35333b')} onChange={event => props.onStyleChange({ stroke: event.target.value })} />
                  <span className="diagram-color-value">{props.style.stroke}</span>
                </div>
              </label>
              <label className="diagram-field" htmlFor={`${id}-width`}>
                <span>Line weight</span>
                <select id={`${id}-width`} aria-label="Line weight" value={props.style.width} onChange={event => props.onStyleChange({ width: Number(event.target.value) })}>
                  {[1, 2, 3, 4, 6, 8].map(width => <option key={width} value={width}>{width} px</option>)}
                  {![1, 2, 3, 4, 6, 8].includes(props.style.width) && <option value={props.style.width}>{props.style.width} px</option>}
                </select>
              </label>
              <label className="diagram-field" htmlFor={`${id}-line-style`}>
                <span>Line style</span>
                <select id={`${id}-line-style`} aria-label="Line style" value={props.style.strokeStyle} onChange={event => props.onStyleChange({ strokeStyle: event.target.value as DiagramStyle['strokeStyle'] })}>
                  <option value="solid">Solid</option><option value="dashed">Dashed</option><option value="dotted">Dotted</option>
                </select>
              </label>
            </div>
          </div>
        </details>

        <details className="diagram-details">
          <summary>Diagram theme <span>Apply colors to this diagram</span></summary>
          <div className="diagram-details-content">
            <div className="diagram-themes" role="group" aria-label="Diagram color themes">
              {DIAGRAM_THEMES.map(theme => <button type="button" key={theme.id} onClick={() => props.onTheme(theme.id)} className="diagram-theme" style={{ '--diagram-theme-fill': theme.fill, '--diagram-theme-stroke': theme.stroke, '--diagram-theme-text': theme.text } as CSSProperties}>
                <span className="diagram-theme-preview" aria-hidden="true"><span /><span /><span /></span>
                <span>{theme.label}</span>
              </button>)}
            </div>
            <p className="diagram-help">A theme updates the colors of the current diagram. You can customize individual shapes and connections afterward.</p>
          </div>
        </details>

        <div className="diagram-panel-footer"><button type="button" className="secondary-button" onClick={props.onExit}>Exit diagram mode</button><button type="button" className="secondary-button" onClick={props.onClose}>Back to board</button></div>
      </div>
    </Modal>
  </div>, document.body);
}
