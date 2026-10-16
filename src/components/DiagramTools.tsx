import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { CaptureUpdateAction, mutateElement } from '@excalidraw/excalidraw';
import type { Arrowhead, ExcalidrawArrowElement, ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { GitBranch, Link2, Plus, Shapes, SlidersHorizontal, Type } from 'lucide-react';
import { DIAGRAM_SYSTEMS, DIAGRAM_THEMES, getDiagramNodes, nextNodePosition, readDiagramData, sidePoint, type DiagramSystemId } from '../lib/diagram-model';
import { attachDiagramEdge, createDiagramEdge, createDiagramNode } from '../lib/diagram-scene';
import { DiagramPanel, type ConnectionSettings, type DiagramStyle } from './DiagramPanel';
import './diagram.css';

function selectedDiagram(elements: readonly ExcalidrawElement[], state: AppState) {
  const byId = new Map(elements.map(element => [element.id, element]));
  const selected = new Map<string, ExcalidrawElement>();
  for (const element of elements) {
    if (element.isDeleted || !state.selectedElementIds[element.id]) continue;
    let primary = element;
    if (element.type === 'text' && element.containerId) primary = byId.get(element.containerId) || element;
    const data = readDiagramData(primary);
    if (data?.kind === 'decoration') primary = byId.get(data.nodeId) || primary;
    if (readDiagramData(primary)?.kind !== 'decoration' && readDiagramData(primary)) selected.set(primary.id, primary);
  }
  const only = selected.size === 1 ? [...selected.values()][0] : null;
  return {
    node: only && readDiagramData(only)?.kind === 'node' ? only : null,
    edge: only?.type === 'arrow' && readDiagramData(only)?.kind === 'edge' ? only as ExcalidrawArrowElement : null,
  };
}
function labelOf(elements: readonly ExcalidrawElement[], node: ExcalidrawElement) {
  const text = elements.find(element => !element.isDeleted && element.type === 'text' && element.containerId === node.id);
  return text?.type === 'text' ? text.text : 'Diagram shape';
}
function styleOf(element: ExcalidrawElement): DiagramStyle {
  return { fill: element.backgroundColor, stroke: element.strokeColor, width: element.strokeWidth, strokeStyle: element.strokeStyle };
}
function defaults(system: DiagramSystemId): ConnectionSettings {
  return { fromSide: 'bottom', toSide: 'top', route: 'elbow', startArrowhead: system === 'crowfoot' || system === 'relational' ? 'crowfoot_one' : null,
    endArrowhead: system === 'process' ? 'arrow' : system === 'crowfoot' || system === 'relational' ? 'crowfoot_many' : null, doubleLine: false };
}
function settingsOf(edge: ExcalidrawElement): ConnectionSettings {
  const data = readDiagramData(edge);
  return { ...defaults(data?.system || 'org'), ...(data?.kind === 'edge' ? { fromSide: data.fromSide, toSide: data.toSide } : {}),
    route: edge.type === 'arrow' && 'elbowed' in edge && edge.elbowed ? 'elbow' : edge.roundness ? 'curved' : 'straight',
    startArrowhead: edge.type === 'arrow' ? edge.startArrowhead : null, endArrowhead: edge.type === 'arrow' ? edge.endArrowhead : null,
    doubleLine: !!edge.customData?.noteDiagram?.doubleLine };
}
function nativeSettings(settings: ConnectionSettings) {
  return { ...settings, startArrowhead: settings.startArrowhead as Arrowhead | null, endArrowhead: settings.endArrowhead as Arrowhead | null };
}

export function DiagramTools({ api, root, onMessage }: { api: ExcalidrawImperativeAPI; root: HTMLDivElement | null; onMessage: (text: string) => void }) {
  const existing = api.getSceneElements().map(readDiagramData).find(data => data?.kind === 'node');
  const [enabled, setEnabled] = useState(!!existing);
  const [panel, setPanel] = useState(false);
  const [system, setSystem] = useState<DiagramSystemId>(existing?.system || 'org');
  const [presetId, setPresetId] = useState(DIAGRAM_SYSTEMS.find(item => item.id === system)!.presets[0].id);
  const [baseStyle, setBaseStyle] = useState<DiagramStyle>({ fill: '#ede9fe', stroke: '#7c3aed', width: 2, strokeStyle: 'solid' });
  const [connection, setConnection] = useState<ConnectionSettings>(() => defaults(system));
  const [placing, setPlacing] = useState(false);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [pointer, setPointer] = useState<[number, number] | null>(null);
  const [host, setHost] = useState<Element | null>(null);
  const activeDiagram = useRef<string | null>(existing?.diagramId || null);
  const [snapshot, setSnapshot] = useState<{ elements: readonly ExcalidrawElement[]; state: AppState; key: string }>(() => ({ elements: api.getSceneElements(), state: api.getAppState(), key: '' }));
  const selection = selectedDiagram(snapshot.elements, snapshot.state);
  const chosen = selection.node || selection.edge;
  const live = useRef({ placing, sourceId, connection, system, presetId, baseStyle });
  live.current = { placing, sourceId, connection, system, presetId, baseStyle };
  useLayoutEffect(() => { setHost(root?.querySelector('.canvas-tools') || null); }, [root]);
  useEffect(() => api.onChange((elements, state) => {
    const key = `${Object.keys(state.selectedElementIds).join(',')}:${elements.map(element => `${element.id}:${element.version}`).join('|')}:${state.scrollX}:${state.scrollY}:${state.zoom.value}:${state.width}:${state.height}:${state.editingTextElement?.id || ''}:${state.cursorButton}`;
    setSnapshot(previous => previous.key === key ? previous : { elements, state, key });
  }), [api]);
  useEffect(() => {
    if (!chosen) return;
    const data = readDiagramData(chosen);
    if (!data) return;
    activeDiagram.current = data.diagramId;
    setSystem(data.system);
    if (data.system !== system) setConnection(defaults(data.system));
    if (data.kind === 'node') setPresetId(data.shapeId);
  }, [chosen?.id]);

  function editLabel(element: ExcalidrawElement) {
    flushSync(() => {
      setPanel(false);
      api.updateScene({ appState: { selectedElementIds: { [element.id]: true }, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.NEVER });
    });
    const editor = root?.querySelector<HTMLElement>('.excalidraw');
    editor?.focus();
    editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
  }
  function commitAdded(added: ExcalidrawElement[], selectedId: string, edit = true) {
    const elements = api.getSceneElementsIncludingDeleted();
    attachDiagramEdge(elements, added);
    flushSync(() => {
      setPanel(false); setPlacing(false); setSourceId(null); setPointer(null);
      api.setActiveTool({ type: 'selection' });
      api.updateScene({ elements: [...elements, ...added], appState: { selectedElementIds: { [selectedId]: true }, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    });
    api.resetCursor();
    const node = api.getSceneElements().find(element => element.id === selectedId);
    if (node && edit) {
      const state = api.getAppState(), zoom = state.zoom.value;
      const left = (node.x + state.scrollX) * zoom, top = (node.y + state.scrollY) * zoom;
      if (left < 24 || top < 100 || left + node.width * zoom > state.width - 24 || top + node.height * zoom > state.height - 80) {
        flushSync(() => api.scrollToContent(node, { fitToContent: false, animate: false }));
      }
      editLabel(node);
    }
  }
  function addRelated(relation: 'child' | 'sibling') {
    const elements = api.getSceneElementsIncludingDeleted();
    const node = selectedDiagram(elements, api.getAppState()).node;
    const data = node && readDiagramData(node);
    if (!node || data?.kind !== 'node') return;
    const palette = DIAGRAM_SYSTEMS.find(item => item.id === data.system)!;
    const preset = palette.presets.find(item => item.id === live.current.presetId) || palette.presets.find(item => item.id === data.shapeId) || palette.presets[0];
    const position = nextNodePosition(getDiagramNodes(elements), node, relation, preset);
    const label = elements.find(element => element.type === 'text' && element.containerId === node.id);
    const added = createDiagramNode(preset, position, data.diagramId, styleOf(node), label?.strokeColor);
    const child = added.find(element => readDiagramData(element)?.kind === 'node')!;
    const parent = position.parentId && elements.find(element => element.id === position.parentId && !element.isDeleted);
    if (parent) added.push(...createDiagramEdge(parent, child, nativeSettings(live.current.connection), styleOf(node)));
    activeDiagram.current = data.diagramId;
    commitAdded(added, child.id);
  }
  function beginConnection() {
    const node = selectedDiagram(api.getSceneElements(), api.getAppState()).node;
    if (!node) return;
    setPanel(false); setPlacing(false); setSourceId(node.id); setPointer(null);
    api.setActiveTool({ type: 'selection' }); api.setCursor('crosshair');
  }
  function cancelOperation() {
    setPlacing(false); setSourceId(null); setPointer(null); api.resetCursor();
  }
  function connectTo(target: ExcalidrawElement) {
    const elements = api.getSceneElementsIncludingDeleted(), source = elements.find(element => element.id === live.current.sourceId);
    const sourceData = source && readDiagramData(source), targetData = readDiagramData(target);
    if (!source || sourceData?.kind !== 'node' || targetData?.kind !== 'node') return;
    // Linking separate diagrams joins their theme scope without changing hierarchy.
    if (targetData.diagramId !== sourceData.diagramId) for (const element of elements) {
      const data = readDiagramData(element);
      if (data?.diagramId === targetData.diagramId) mutateElement(element, { customData: { ...element.customData, noteDiagram: { ...data, diagramId: sourceData.diagramId } } });
    }
    const added = createDiagramEdge(source, target, nativeSettings(live.current.connection), live.current.baseStyle);
    const edge = added.find(element => element.type === 'arrow')!;
    activeDiagram.current = sourceData.diagramId;
    commitAdded(added, edge.id, false);
  }
  useEffect(() => {
    const up = api.onPointerUp((_tool, _down, event) => {
      if (!live.current.placing && !live.current.sourceId) return;
      const state = api.getAppState();
      const x = (event.clientX - state.offsetLeft) / state.zoom.value - state.scrollX;
      const y = (event.clientY - state.offsetTop) / state.zoom.value - state.scrollY;
      if (live.current.placing) {
        const palette = DIAGRAM_SYSTEMS.find(item => item.id === live.current.system)!;
        const preset = palette.presets.find(item => item.id === live.current.presetId) || palette.presets[0];
        const diagramId = crypto.randomUUID();
        const added = createDiagramNode(preset, { x: x - preset.width / 2, y: y - preset.height / 2, parentId: null }, diagramId, live.current.baseStyle);
        activeDiagram.current = diagramId;
        commitAdded(added, added.find(element => readDiagramData(element)?.kind === 'node')!.id);
      } else {
        const target = getDiagramNodes(api.getSceneElements()).slice().reverse().find(node => x >= node.x && x <= node.x + node.width && y >= node.y && y <= node.y + node.height);
        if (target) connectTo(target);
      }
    });
    const move = (event: PointerEvent) => { if (live.current.sourceId && root) { const bounds = root.getBoundingClientRect(); setPointer([event.clientX - bounds.left, event.clientY - bounds.top]); } };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && (live.current.placing || live.current.sourceId)) cancelOperation(); };
    root?.addEventListener('pointermove', move); document.addEventListener('keydown', key);
    return () => { up(); root?.removeEventListener('pointermove', move); document.removeEventListener('keydown', key); api.resetCursor(); };
  }, [api, root]);

  function applyStyle(patch: Partial<DiagramStyle>) {
    setBaseStyle(previous => ({ ...previous, ...patch }));
    const elements = api.getSceneElementsIncludingDeleted(), selected = selectedDiagram(elements, api.getAppState());
    const primary = selected.node || selected.edge;
    if (!primary) return;
    for (const element of elements) {
      const data = readDiagramData(element);
      if (element.id !== primary.id && !(data?.kind === 'decoration' && data.nodeId === primary.id)) continue;
      mutateElement(element, { ...(patch.fill !== undefined && selected.node ? { backgroundColor: data?.kind === 'decoration' ? 'transparent' : patch.fill } : {}),
        ...(patch.stroke !== undefined ? { strokeColor: patch.stroke } : {}), ...(patch.width !== undefined ? { strokeWidth: patch.width } : {}), ...(patch.strokeStyle !== undefined ? { strokeStyle: patch.strokeStyle } : {}) });
    }
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }
  function applyConnection(patch: Partial<ConnectionSettings>) {
    setConnection(previous => ({ ...previous, ...patch }));
    const elements: ExcalidrawElement[] = [...api.getSceneElementsIncludingDeleted()], edge = selectedDiagram(elements, api.getAppState()).edge;
    const data = edge && readDiagramData(edge);
    if (!edge || data?.kind !== 'edge') return;
    const from = elements.find(element => element.id === data.fromId), to = elements.find(element => element.id === data.toId);
    if (!from || !to) return;
    const settings = { ...settingsOf(edge), ...patch }, fresh = createDiagramEdge(from, to, nativeSettings(settings), styleOf(edge));
    const replacement = fresh.find(element => element.type === 'arrow');
    if (!replacement || replacement.type !== 'arrow') return;
    const routeChanged = patch.route !== undefined || patch.fromSide !== undefined || patch.toSide !== undefined;
    mutateElement(edge, { ...(routeChanged ? { x: replacement.x, y: replacement.y, width: replacement.width, height: replacement.height, points: replacement.points, startBinding: replacement.startBinding, endBinding: replacement.endBinding,
      elbowed: 'elbowed' in replacement && replacement.elbowed, roundness: replacement.roundness, fixedSegments: null } : {}), startArrowhead: replacement.startArrowhead, endArrowhead: replacement.endArrowhead,
      customData: { ...edge.customData, noteDiagram: { ...data, fromSide: settings.fromSide, toSide: settings.toSide, doubleLine: settings.doubleLine } } });
    const decorations = elements.filter(element => { const item = readDiagramData(element); return !element.isDeleted && item?.kind === 'decoration' && item.nodeId === edge.id; });
    if (!settings.doubleLine) for (const element of decorations) mutateElement(element, { isDeleted: true });
    if (settings.doubleLine && !decorations.length) {
      const decoration = fresh.find(element => readDiagramData(element)?.kind === 'decoration');
      if (decoration) { const item = readDiagramData(decoration)!; mutateElement(decoration, { customData: { ...decoration.customData, noteDiagram: { ...item, nodeId: edge.id } } }); elements.push(decoration); }
    }
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }
  function applyTheme(themeId: string) {
    const theme = DIAGRAM_THEMES.find(item => item.id === themeId);
    if (!theme) return;
    setBaseStyle(previous => ({ ...previous, fill: theme.fill, stroke: theme.stroke }));
    const elements = api.getSceneElementsIncludingDeleted(), selected = selectedDiagram(elements, api.getAppState());
    const identity = (selected.node || selected.edge) && readDiagramData((selected.node || selected.edge)!);
    const diagramId = identity?.diagramId || activeDiagram.current;
    if (!diagramId) { onMessage('Theme selected for new shapes.'); return; }
    const members = new Set(elements.filter(element => readDiagramData(element)?.diagramId === diagramId).map(element => element.id));
    for (const element of elements) {
      if (element.isDeleted) continue;
      if (members.has(element.id)) { const data = readDiagramData(element); mutateElement(element, { strokeColor: theme.stroke, ...(data?.kind === 'node' ? { backgroundColor: theme.fill } : {}) }); }
      if (element.type === 'text' && element.containerId && members.has(element.containerId)) mutateElement(element, { strokeColor: theme.text });
    }
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  }
  function editBends() {
    const edge = selectedDiagram(api.getSceneElements(), api.getAppState()).edge;
    if (!edge) return;
    flushSync(() => { api.updateScene({ appState: { selectedElementIds: { [edge.id]: true }, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.NEVER }); });
    const editor = root?.querySelector<HTMLElement>('.excalidraw'); editor?.focus();
    if (edge.elbowed) onMessage('Drag a connection segment to add a bend or change its route.');
    else editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
  }

  const bounds = root?.getBoundingClientRect();
  const project = (point: [number, number]): [number, number] => [(point[0] + snapshot.state.scrollX) * snapshot.state.zoom.value + snapshot.state.offsetLeft - (bounds?.left || 0), (point[1] + snapshot.state.scrollY) * snapshot.state.zoom.value + snapshot.state.offsetTop - (bounds?.top || 0)];
  const nodeCenter = chosen && project([chosen.x + chosen.width / 2, chosen.y]);
  const editorTop = (root?.querySelector('.excalidraw')?.getBoundingClientRect().top || bounds?.top || 0) - (bounds?.top || 0);
  const actionPosition = nodeCenter && { left: Math.max(8, Math.min((bounds?.width || 400) - 320, nodeCenter[0] - 152)), top: Math.max(editorTop + 72, Math.min((bounds?.height || 600) - 116, nodeCenter[1] - 52)) };
  const source = sourceId && snapshot.elements.find(element => element.id === sourceId);
  const start = source ? project(sidePoint(source, connection.fromSide)) : null;
  const selectedData = selection.node && readDiagramData(selection.node);
  const selectedStyle = chosen ? styleOf(chosen) : baseStyle;
  const selectedConnection = selection.edge ? settingsOf(selection.edge) : connection;
  return <>
    {host && createPortal(<button className="diagram-mode-button" aria-pressed={enabled} onClick={() => { setEnabled(true); setPanel(true); }} title="Diagram shape libraries, connections, and themes"><Shapes size={15} />Diagrams</button>, host)}
    {enabled && !panel && !placing && !sourceId && chosen && actionPosition && !snapshot.state.editingTextElement && snapshot.state.cursorButton !== 'down' && <div className="diagram-quick-actions" style={actionPosition} role="group" aria-label={selection.node ? 'Selected diagram shape actions' : 'Selected diagram connection actions'}>
      {selection.node ? <><button onClick={() => addRelated('sibling')}><Plus size={14} />Add sibling</button><button onClick={() => addRelated('child')}><GitBranch size={14} />Add child</button><button onClick={beginConnection}><Link2 size={14} />Add connection</button></>
        : <><button onClick={editBends}><GitBranch size={14} />Edit bends</button><button onClick={() => editLabel(selection.edge!)}><Type size={14} />Label</button><button onClick={() => setPanel(true)}><SlidersHorizontal size={14} />Line options</button></>}
    </div>}
    {(placing || sourceId) && <div className="diagram-operation" role="status" style={{ top: editorTop + 72 }}>
      <span>{placing ? 'Tap the board to place your shape, then type.' : 'Tap a target shape to connect. Loops back to earlier shapes are allowed.'}</span>
      {sourceId && <><label>From<select aria-label="Connection from side" value={connection.fromSide} onChange={event => setConnection(previous => ({ ...previous, fromSide: event.target.value as ConnectionSettings['fromSide'] }))}>{['top', 'right', 'bottom', 'left'].map(side => <option key={side}>{side}</option>)}</select></label><label>To<select aria-label="Connection to side" value={connection.toSide} onChange={event => setConnection(previous => ({ ...previous, toSide: event.target.value as ConnectionSettings['toSide'] }))}>{['top', 'right', 'bottom', 'left'].map(side => <option key={side}>{side}</option>)}</select></label></>}
      <button onClick={cancelOperation}>Cancel</button>
    </div>}
    {sourceId && start && pointer && <svg className="diagram-connection-preview" aria-hidden="true"><path d={`M${start[0]} ${start[1]} L${pointer[0]} ${pointer[1]}`} /></svg>}
    {panel && <DiagramPanel system={system} presetId={presetId} onSystemChange={value => { setSystem(value); setPresetId(DIAGRAM_SYSTEMS.find(item => item.id === value)!.presets[0].id); setConnection(defaults(value)); activeDiagram.current = null; api.updateScene({ appState: { selectedElementIds: {}, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.NEVER }); }} onPresetChange={setPresetId}
      onAddShape={() => { setPanel(false); setSourceId(null); setPlacing(true); api.setActiveTool({ type: 'selection' }); api.setCursor('crosshair'); }}
      selectedNode={selection.node && selectedData?.kind === 'node' ? { id: selection.node.id, label: labelOf(snapshot.elements, selection.node), parentId: selectedData.parentId } : null} selectedEdge={!!selection.edge}
      onAddSibling={() => addRelated('sibling')} onAddChild={() => addRelated('child')} onConnect={beginConnection} onEditLabel={() => { if (chosen) editLabel(chosen); }} connecting={!!sourceId} onCancelConnection={cancelOperation}
      connection={selectedConnection} onConnectionChange={applyConnection} style={selectedStyle} onStyleChange={applyStyle} onTheme={applyTheme} onClose={() => setPanel(false)} onExit={() => { setPanel(false); setEnabled(false); cancelOperation(); }} />}
  </>;
}
