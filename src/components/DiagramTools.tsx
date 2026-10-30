import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { CaptureUpdateAction, mutateElement, newElementWith } from '@excalidraw/excalidraw';
import type { Arrowhead, ExcalidrawArrowElement, ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { GitBranch, Link2, Plus, Shapes, SlidersHorizontal, Type } from 'lucide-react';
import { DIAGRAM_SYSTEMS, DIAGRAM_THEMES, getDiagramNodes, nextNodePosition, readDiagramData, sidePoint, type DiagramSystemId } from '../lib/diagram-model';
import { attachDiagramEdge, createDiagramEdge, createObjectConnection, createDiagramNode, changeDiagramNodeShape } from '../lib/diagram-scene';
import { connectionPrimary, connectionTarget, connectionTargetAt, selectedConnectionTargets } from '../lib/connection-targets';
import { diagramShortcutNode, diagramShortcutRelation } from '../lib/diagram-shortcuts';
import { richTextColor } from '../lib/rich-text';
import { DiagramPanel, type ConnectionSettings, type DiagramStyle } from './DiagramPanel';
import './diagram.css';

function selectedDiagram(elements: readonly ExcalidrawElement[], state: AppState) {
  const objects = selectedConnectionTargets(elements, state.selectedElementIds);
  const selected = new Map<string, ExcalidrawElement>();
  for (const element of elements) {
    if (element.isDeleted || element.locked || !state.selectedElementIds[element.id]) continue;
    const primary = connectionPrimary(element, elements);
    if (primary.locked) continue;
    if (readDiagramData(primary)?.kind !== 'decoration' && readDiagramData(primary)) selected.set(primary.id, primary);
  }
  const only = selected.size === 1 ? [...selected.values()][0] : null;
  const node = only && readDiagramData(only)?.kind === 'node' && objects.length === 1 && !objects[0].groupId ? only : null;
  return {
    node,
    edge: !objects.length && only?.type === 'arrow' && readDiagramData(only)?.kind === 'edge' ? only as ExcalidrawArrowElement : null,
    object: !node && objects.length === 1 && !elements.some(element => state.selectedElementIds[element.id] && readDiagramData(connectionPrimary(element, elements))?.kind === 'edge') ? objects[0] : null,
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
  const manuallyExited = useRef(false);
  const [panel, setPanel] = useState(false);
  const [pendingRelation, setPendingRelation] = useState<'child' | 'sibling' | null>(null);
  useLayoutEffect(() => {
    if (!root || !panel) return;
    const wasInert = root.inert;
    root.inert = true;
    root.classList.add('diagram-panel-open');
    api.updateScene({ appState: { openMenu: null }, captureUpdate: CaptureUpdateAction.NEVER });
    return () => { root.inert = wasInert; root.classList.remove('diagram-panel-open'); };
  }, [root, panel, api]);
  const [system, setSystem] = useState<DiagramSystemId>(existing?.system || 'org');
  const [presetId, setPresetId] = useState(DIAGRAM_SYSTEMS.find(item => item.id === system)!.presets[0].id);
  const [baseStyle, setBaseStyle] = useState<DiagramStyle>({ fill: '#ede9fe', stroke: '#7c3aed', width: 2, strokeStyle: 'solid' });
  const [connection, setConnection] = useState<ConnectionSettings>(() => defaults(system));
  const [placing, setPlacing] = useState(false);
  const [sourceId, setSourceId] = useState<string | null>(null);
  const [pointer, setPointer] = useState<[number, number] | null>(null);
  const [host, setHost] = useState<Element | null>(null);
  const [mobileActionSlot, setMobileActionSlot] = useState<HTMLDivElement | null>(null);
  const activeDiagram = useRef<string | null>(existing?.diagramId || null);
  const [snapshot, setSnapshot] = useState<{ elements: readonly ExcalidrawElement[]; state: AppState; key: string }>(() => ({ elements: api.getSceneElements(), state: api.getAppState(), key: '' }));
  const selection = selectedDiagram(snapshot.elements, snapshot.state);
  const chosen = selection.node || selection.edge || selection.object?.element;
  const live = useRef({ enabled, panel, placing, sourceId, connection, system, presetId, baseStyle });
  live.current = { enabled, panel, placing, sourceId, connection, system, presetId, baseStyle };
  useLayoutEffect(() => { setHost(root?.querySelector('[data-toolbar-slot="actions-diagrams"]') || null); }, [root]);
  useLayoutEffect(() => {
    if (!root) return;
    let target: Element | null = null, slot: HTMLDivElement | null = null;
    const locate = () => {
      // Follow the panel actually rendered by the editor. Its openMenu flag
      // can remain set on desktop, where no covering mobile panel exists.
      const next = root.querySelector('.excalidraw--mobile .App-mobile-menu .panelColumn');
      if (target === next) return;
      slot?.remove(); target = next;
      if (target) {
        slot = document.createElement('div');
        target.prepend(slot); setMobileActionSlot(slot);
      } else { slot = null; setMobileActionSlot(null); }
    };
    locate();
    const observer = new MutationObserver(locate);
    observer.observe(root, { childList: true, subtree: true });
    return () => { observer.disconnect(); slot?.remove(); };
  }, [root]);
  useEffect(() => api.onChange((elements, state) => {
    const key = `${Object.keys(state.selectedElementIds).join(',')}:${elements.map(element => `${element.id}:${element.version}`).join('|')}:${state.scrollX}:${state.scrollY}:${state.zoom.value}:${state.width}:${state.height}:${state.editingTextElement?.id || ''}:${state.cursorButton}:${state.openMenu || ''}`;
    setSnapshot(previous => previous.key === key ? previous : { elements, state, key });
  }), [api]);
  useEffect(() => {
    if (!chosen) return;
    const data = readDiagramData(chosen);
    if (!data) return;
    // Saved scenes can finish loading after this component initializes.
    // Selecting a diagram item should activate its actions unless the user
    // explicitly exited diagram mode during this board session.
    if (!manuallyExited.current) setEnabled(true);
    activeDiagram.current = data.diagramId;
    setSystem(data.system);
    if (data.system !== system) setConnection(defaults(data.system));
    if (data.kind === 'node') setPresetId(data.shapeId);
  }, [chosen?.id]);

  function openPanel() { setPendingRelation(null); setPanel(true); }
  function closePanel() { setPendingRelation(null); setPanel(false); }
  function chooseRelated(relation: 'child' | 'sibling') {
    const node = selectedDiagram(api.getSceneElements(), api.getAppState()).node;
    const data = node && readDiagramData(node);
    if (data?.kind !== 'node') return;
    const palette = DIAGRAM_SYSTEMS.find(item => item.id === data.system)!;
    if (palette.presets.length === 1) { addRelated(relation); return; }
    setSystem(data.system); setPresetId(data.shapeId); setPendingRelation(relation); setPanel(true);
  }
  function applyShape() {
    const node = selectedDiagram(api.getSceneElements(), api.getAppState()).node;
    const preset = DIAGRAM_SYSTEMS.find(item => item.id === system)?.presets.find(item => item.id === presetId);
    if (!node || !preset) return;
    const elements = changeDiagramNodeShape(api.getSceneElementsIncludingDeleted(), node.id, preset);
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    onMessage(`Shape changed to ${preset.label}.`);
  }

  function editLabel(element: ExcalidrawElement, selectText = false) {
    flushSync(() => {
      setPanel(false);
      api.updateScene({ appState: { selectedElementIds: { [element.id]: true }, selectedGroupIds: {}, openMenu: null }, captureUpdate: CaptureUpdateAction.NEVER });
    });
    const editor = root?.querySelector<HTMLElement>('.excalidraw');
    editor?.focus();
    editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    // Touch devices deliberately skip Excalidraw's native auto-selection. New labels
    // should still be replaced by the first keystroke, including hardware keyboards.
    if (selectText) {
      const input = root?.querySelector<HTMLTextAreaElement>('textarea.excalidraw-wysiwyg');
      input?.focus();
      input?.select();
    }
    root?.dispatchEvent(new Event('note-rich-text-edit'));
  }
  function commitAdded(added: ExcalidrawElement[], selectedId: string, edit = true, base = api.getSceneElementsIncludingDeleted()) {
    const elements = structuredClone(base);
    attachDiagramEdge(elements, added);
    flushSync(() => {
      setPanel(false); setPendingRelation(null); setPlacing(false); setSourceId(null); setPointer(null);
      api.setActiveTool({ type: 'selection' });
      api.updateScene({ elements: [...elements, ...added], appState: { selectedElementIds: { [selectedId]: true }, selectedGroupIds: {}, openMenu: null }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    });
    api.resetCursor();
    const node = api.getSceneElements().find(element => element.id === selectedId);
    if (node && edit) {
      const state = api.getAppState(), zoom = state.zoom.value;
      const left = (node.x + state.scrollX) * zoom, top = (node.y + state.scrollY) * zoom;
      if (left < 24 || top < 100 || left + node.width * zoom > state.width - 24 || top + node.height * zoom > state.height - 80) {
        flushSync(() => api.scrollToContent(node, { fitToContent: false, animate: false }));
      }
      root?.dispatchEvent(new CustomEvent('note-diagram-node-created', { detail: { nodeId: node.id } }));
      editLabel(node, true);
    }
  }
  function addRelated(relation: 'child' | 'sibling', matchSelected = false) {
    const elements = api.getSceneElementsIncludingDeleted();
    const node = selectedDiagram(elements, api.getAppState()).node;
    const data = node && readDiagramData(node);
    if (!node || data?.kind !== 'node') return;
    const palette = DIAGRAM_SYSTEMS.find(item => item.id === data.system)!;
    const sourcePreset = palette.presets.find(item => item.id === data.shapeId) || palette.presets[0];
    const preset = matchSelected ? { ...sourcePreset, width: node.width, height: node.height }
      : palette.presets.find(item => item.id === live.current.presetId) || sourcePreset;
    const position = nextNodePosition(getDiagramNodes(elements), node, relation, preset);
    const label = elements.find(element => !element.isDeleted && element.type === 'text' && element.containerId === node.id);
    const added = createDiagramNode(preset, position, data.diagramId, styleOf(node), label ? richTextColor(label) : undefined);
    const child = added.find(element => readDiagramData(element)?.kind === 'node')!;
    if (matchSelected) for (const element of added) {
      if (element.type === 'text' && label?.type === 'text') mutateElement(element, {
        fontSize: label.fontSize, fontFamily: label.fontFamily, lineHeight: label.lineHeight,
        textAlign: label.textAlign, verticalAlign: label.verticalAlign, opacity: label.opacity,
      }, false);
      else if (element.type !== 'text') mutateElement(element, {
        ...(element.id === child.id ? { width: node.width, height: node.height } : {}),
        fillStyle: node.fillStyle, roughness: node.roughness, roundness: node.roundness, opacity: node.opacity,
      }, false);
    }
    const parent = position.parentId && elements.find(element => element.id === position.parentId && !element.isDeleted);
    if (parent) added.push(...createDiagramEdge(parent, child, nativeSettings(live.current.connection), styleOf(node)));
    activeDiagram.current = data.diagramId;
    commitAdded(added, child.id);
  }
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const relation = diagramShortcutRelation(event), current = live.current;
      if (!relation || !root || !current.enabled || current.panel || current.placing || current.sourceId) return;
      const editor = root.querySelector<HTMLElement>('.excalidraw');
      const target = event.target;
      if (!editor || !(target instanceof HTMLElement) || !editor.contains(target)) return;
      // Excalidraw's inline color/font palettes also use role=dialog. Their inputs
      // are excluded by the focus guard; only an application modal blocks canvas keys.
      const dialogOpen = [...document.querySelectorAll<HTMLElement>('[role="dialog"], dialog[open]')]
        .some(dialog => !editor.contains(dialog) && dialog.getClientRects().length > 0 && getComputedStyle(dialog).visibility !== 'hidden');
      if (dialogOpen) return;
      const nativeText = target instanceof HTMLTextAreaElement && target.classList.contains('excalidraw-wysiwyg');
      if (!nativeText && target !== editor && !(target instanceof HTMLCanvasElement)) return;
      const state = api.getAppState();
      if (state.openDialog || state.viewModeEnabled) return;
      if (!!state.editingTextElement !== nativeText) return;
      const node = diagramShortcutNode(api.getSceneElements(), state);
      if (!node || node.locked) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      // Native text installs its blur handler on a timer. Submit through its
      // synchronous keyboard handler so rapid Tab commands also clean up the old
      // editor before creating and focusing the next label in this same keydown.
      flushSync(() => {
        if (nativeText) target.dispatchEvent(new KeyboardEvent('keydown', {
          key: 'Enter', code: 'Enter', ctrlKey: true, metaKey: true, cancelable: true,
        }));
        api.updateScene({ appState: { selectedElementIds: { [node.id]: true }, selectedGroupIds: {}, openMenu: null }, captureUpdate: CaptureUpdateAction.NEVER });
      });
      if (nativeText && target.isConnected) return;
      addRelated(relation, true);
    };
    document.addEventListener('keydown', shortcut, true);
    return () => document.removeEventListener('keydown', shortcut, true);
  }, [api, root]);
  function beginConnection() {
    const selected = selectedDiagram(api.getSceneElements(), api.getAppState());
    const node = selected.node || selected.object?.element;
    if (!node) return;
    root?.dispatchEvent(new Event('note:diagram-placement'));
    setPanel(false); setPlacing(false); setSourceId(node.id); setPointer(null);
    api.updateScene({ appState: { openMenu: null }, captureUpdate: CaptureUpdateAction.NEVER });
    api.setActiveTool({ type: 'selection' }); api.setCursor('crosshair');
  }
  function cancelOperation() {
    setPlacing(false); setSourceId(null); setPointer(null); api.resetCursor();
  }
  useEffect(() => {
    const beginStamping = () => {
      // Stamp activation and a canvas pointer-up may share the same event turn.
      // Clear the live operation before React renders the canceled diagram UI.
      live.current.panel = false;
      live.current.placing = false;
      live.current.sourceId = null;
      cancelOperation();
      closePanel();
    };
    root?.addEventListener('note-board-tool-activate', beginStamping);
    return () => root?.removeEventListener('note-board-tool-activate', beginStamping);
  }, [api, root]);
  function connectTo(target: ExcalidrawElement) {
    const elements = structuredClone(api.getSceneElementsIncludingDeleted()), source = elements.find(element => element.id === live.current.sourceId);
    const sourceData = source && readDiagramData(source), targetData = readDiagramData(target);
    if (!source) return;
    const diagramConnection = sourceData?.kind === 'node' && targetData?.kind === 'node' && !connectionTarget(elements, source.id)?.groupId && !connectionTarget(elements, target.id)?.groupId;
    // Linking separate diagrams joins their theme scope without changing hierarchy.
    if (diagramConnection && targetData.diagramId !== sourceData.diagramId) for (const element of elements) {
      const data = readDiagramData(element);
      if (data?.diagramId === targetData.diagramId) mutateElement(element, { customData: { ...element.customData, noteDiagram: { ...data, diagramId: sourceData.diagramId } } }, false);
    }
    const added = diagramConnection
      ? createDiagramEdge(source, target, nativeSettings(live.current.connection), live.current.baseStyle)
      : createObjectConnection(elements, source.id, target.id, nativeSettings(live.current.connection), live.current.baseStyle);
    const edge = added.find(element => element.type === 'arrow')!;
    activeDiagram.current = sourceData?.kind === 'node' ? sourceData.diagramId : null;
    commitAdded(added, edge.id, false, elements);
  }
  useEffect(() => {
    const cancelStampConflict = () => cancelOperation();
    root?.addEventListener('note:icon-stamp', cancelStampConflict);
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
        const target = connectionTargetAt(api.getSceneElements(), [x, y]);
        const source = live.current.sourceId && connectionTarget(api.getSceneElements(), live.current.sourceId);
        if (target && source && target.element.id !== source.element.id && !(source.groupId && source.groupId === target.groupId)) connectTo(target.element);
      }
    });
    const move = (event: PointerEvent) => { if (live.current.sourceId && root) { const bounds = root.getBoundingClientRect(); setPointer([event.clientX - bounds.left, event.clientY - bounds.top]); } };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape' && (live.current.placing || live.current.sourceId)) cancelOperation(); };
    root?.addEventListener('pointermove', move); document.addEventListener('keydown', key);
    return () => { up(); root?.removeEventListener('note:icon-stamp', cancelStampConflict); root?.removeEventListener('pointermove', move); document.removeEventListener('keydown', key); api.resetCursor(); };
  }, [api, root]);

  function applyStyle(patch: Partial<DiagramStyle>) {
    setBaseStyle(previous => ({ ...previous, ...patch }));
    const elements = structuredClone(api.getSceneElementsIncludingDeleted()), selected = selectedDiagram(elements, api.getAppState());
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
    const settings = { ...settingsOf(edge), ...patch }, edgeSettings = {
      ...nativeSettings(settings), fromAnchor: patch.fromSide === undefined ? data.fromAnchor : undefined,
      toAnchor: patch.toSide === undefined ? data.toAnchor : undefined,
    };
    const fresh = data.universal ? createObjectConnection(elements, from.id, to.id, edgeSettings, styleOf(edge)) : createDiagramEdge(from, to, edgeSettings, styleOf(edge));
    const replacement = fresh.find(element => element.type === 'arrow');
    if (!replacement || replacement.type !== 'arrow') return;
    const routeChanged = patch.route !== undefined || patch.fromSide !== undefined || patch.toSide !== undefined;
    const anchors = readDiagramData(replacement);
    const updated = newElementWith(edge, { ...(routeChanged ? { x: replacement.x, y: replacement.y, width: replacement.width, height: replacement.height, points: replacement.points, startBinding: replacement.startBinding, endBinding: replacement.endBinding,
      elbowed: 'elbowed' in replacement && replacement.elbowed, roundness: replacement.roundness, fixedSegments: null } : {}), startArrowhead: replacement.startArrowhead, endArrowhead: replacement.endArrowhead,
      customData: { ...edge.customData, noteDiagram: { ...data, ...(routeChanged && anchors?.kind === 'edge' ? { fromAnchor: anchors.fromAnchor, toAnchor: anchors.toAnchor } : {}), fromSide: settings.fromSide, toSide: settings.toSide, doubleLine: settings.doubleLine } } });
    elements[elements.indexOf(edge)] = updated;
    const decorations = elements.filter(element => { const item = readDiagramData(element); return !element.isDeleted && item?.kind === 'decoration' && item.nodeId === edge.id; });
    if (!settings.doubleLine) for (const element of decorations) elements[elements.indexOf(element)] = newElementWith(element, { isDeleted: true });
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
    const elements = structuredClone(api.getSceneElementsIncludingDeleted()), selected = selectedDiagram(elements, api.getAppState());
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
    flushSync(() => { api.updateScene({ appState: { selectedElementIds: { [edge.id]: true }, selectedGroupIds: {}, openMenu: null }, captureUpdate: CaptureUpdateAction.NEVER }); });
    const editor = root?.querySelector<HTMLElement>('.excalidraw'); editor?.focus();
    if (edge.elbowed) onMessage('Drag a connection segment to add a bend or change its route.');
    else editor?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
  }

  const bounds = root?.getBoundingClientRect();
  const project = (point: [number, number]): [number, number] => [(point[0] + snapshot.state.scrollX) * snapshot.state.zoom.value + snapshot.state.offsetLeft - (bounds?.left || 0), (point[1] + snapshot.state.scrollY) * snapshot.state.zoom.value + snapshot.state.offsetTop - (bounds?.top || 0)];
  const chosenGeometry = selection.object?.geometry || chosen;
  const nodeCenter = chosenGeometry && project([chosenGeometry.x + chosenGeometry.width / 2, chosenGeometry.y]);
  const editorTop = (root?.querySelector('.excalidraw')?.getBoundingClientRect().top || bounds?.top || 0) - (bounds?.top || 0);
  const actionHeight = selection.node ? 102 : 52;
  const actionPosition = nodeCenter && { left: Math.max(8, Math.min((bounds?.width || 400) - 320, nodeCenter[0] - 152)), top: Math.max(editorTop + 72, Math.min((bounds?.height || 600) - actionHeight - 16, nodeCenter[1] - actionHeight - 8)) };
  const source = sourceId && connectionTarget(snapshot.elements, sourceId);
  const start = source ? project(sidePoint(source.geometry, connection.fromSide)) : null;
  const selectedData = selection.node && readDiagramData(selection.node);
  const selectedStyle = chosen ? styleOf(chosen) : baseStyle;
  const selectedConnection = selection.edge ? settingsOf(selection.edge) : connection;
  const showActions = (enabled || selection.object || selection.edge?.customData?.noteDiagram?.universal) && !panel && !placing && !sourceId && chosen && !snapshot.state.editingTextElement && snapshot.state.cursorButton !== 'down';
  const actions = selection.node ? <><button onClick={() => chooseRelated('sibling')}><Plus size={14} />Add sibling</button><button onClick={() => chooseRelated('child')}><GitBranch size={14} />Add child</button><button onClick={beginConnection}><Link2 size={14} />Add connection</button><button onClick={openPanel}><Shapes size={14} />Edit shape</button></>
    : selection.object ? <button onClick={beginConnection}><Link2 size={14} />Add connection</button>
    : <><button onClick={editBends}><GitBranch size={14} />Edit bends</button><button onClick={() => editLabel(selection.edge!)}><Type size={14} />Label</button><button onClick={openPanel}><SlidersHorizontal size={14} />Line options</button></>;
  const actionLabel = selection.node ? 'Selected diagram shape actions' : selection.object ? 'Selected object connections' : 'Selected diagram connection actions';
  return <>
    {host && createPortal(<button className="diagram-mode-button" aria-label="Diagrams" aria-pressed={enabled} onClick={() => { manuallyExited.current = false; setEnabled(true); openPanel(); }} title="Diagram shape libraries, connections, and themes"><Shapes size={15} /><span>Diagrams</span></button>, host)}
    {showActions && (mobileActionSlot ? createPortal(<div className="diagram-inline-actions" role="group" aria-label={actionLabel}>{actions}</div>, mobileActionSlot)
      : actionPosition && snapshot.state.openMenu !== 'canvas' && <div className={`diagram-quick-actions ${selection.node ? 'diagram-node-quick-actions' : ''}`} style={actionPosition} role="group" aria-label={actionLabel}>{actions}</div>)}
    {(placing || sourceId) && <div className="diagram-operation" role="status" style={{ top: editorTop + 72 }}>
      <span>{placing ? 'Tap the board to place your shape, then type.' : 'Tap a board object to connect. Connections follow shapes, text, images, drawings, and groups.'}</span>
      {sourceId && <><label>From<select aria-label="Connection from side" value={connection.fromSide} onChange={event => setConnection(previous => ({ ...previous, fromSide: event.target.value as ConnectionSettings['fromSide'] }))}>{['top', 'right', 'bottom', 'left'].map(side => <option key={side}>{side}</option>)}</select></label><label>To<select aria-label="Connection to side" value={connection.toSide} onChange={event => setConnection(previous => ({ ...previous, toSide: event.target.value as ConnectionSettings['toSide'] }))}>{['top', 'right', 'bottom', 'left'].map(side => <option key={side}>{side}</option>)}</select></label></>}
      <button onClick={cancelOperation}>Cancel</button>
    </div>}
    {sourceId && start && pointer && <svg className="diagram-connection-preview" aria-hidden="true"><path d={`M${start[0]} ${start[1]} L${pointer[0]} ${pointer[1]}`} /></svg>}
    {panel && <DiagramPanel system={system} presetId={presetId} onSystemChange={value => { setSystem(value); setPresetId(DIAGRAM_SYSTEMS.find(item => item.id === value)!.presets[0].id); setConnection(defaults(value)); activeDiagram.current = null; api.updateScene({ appState: { selectedElementIds: {}, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.NEVER }); }} onPresetChange={setPresetId} onApplyShape={applyShape} pendingRelation={pendingRelation} onConfirmRelated={() => { if (pendingRelation) addRelated(pendingRelation); }} onCancelRelated={() => setPendingRelation(null)}
      onAddShape={() => { root?.dispatchEvent(new Event('note:diagram-placement')); setPanel(false); setSourceId(null); setPlacing(true); api.setActiveTool({ type: 'selection' }); api.setCursor('crosshair'); }}
      selectedNode={selection.node && selectedData?.kind === 'node' ? { id: selection.node.id, label: labelOf(snapshot.elements, selection.node), shapeId: selectedData.shapeId, parentId: selectedData.parentId } : null} selectedEdge={!!selection.edge}
      onAddSibling={() => chooseRelated('sibling')} onAddChild={() => chooseRelated('child')} onConnect={beginConnection} onEditLabel={() => { if (chosen) editLabel(chosen); }} connecting={!!sourceId} onCancelConnection={cancelOperation}
      connection={selectedConnection} onConnectionChange={applyConnection} style={selectedStyle} onStyleChange={applyStyle} onTheme={applyTheme} onClose={closePanel} onExit={() => { manuallyExited.current = true; closePanel(); setEnabled(false); cancelOperation(); }} />}
  </>;
}
