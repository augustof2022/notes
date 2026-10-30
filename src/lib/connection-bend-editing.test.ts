import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
vi.mock('@excalidraw/excalidraw', () => ({
  CaptureUpdateAction: { IMMEDIATELY: 'IMMEDIATELY' },
  getCommonBounds: (elements: any[]) => [elements[0].x, elements[0].y, elements[0].x + elements[0].width, elements[0].y + elements[0].height],
  newElementWith: (element: any, updates: object) => ({ ...element, ...updates, version: element.version + 1 }),
}));
import { installConnectionBendEditing } from './connection-bend-editing';

class Canvas extends EventTarget {
  contains(target: unknown) { return target === this; }
  hasAttribute() { return false; }
  querySelector() { return null; }
}
function event(type: string, properties: Record<string, unknown> = {}) {
  const input = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(properties)) Object.defineProperty(input, key, { value });
  return input;
}
const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function fixture() {
  const root = new Canvas(), win = new EventTarget();
  vi.stubGlobal('HTMLCanvasElement', Canvas); vi.stubGlobal('window', win);
  const edge = { id: 'edge', type: 'arrow', x: 0, y: 0, width: 100, height: 100, angle: 0,
    points: [[0, 0], [100, 0], [100, 100]], elbowed: true, fixedSegments: [{ index: 1 }], groupIds: [], locked: false, version: 1,
    startBinding: { elementId: 'a', focus: 0, gap: 0 }, endBinding: { elementId: 'b', focus: 0, gap: 0 },
    customData: { noteDiagram: { kind: 'edge', diagramId: 'diagram', system: 'org', fromId: 'a', toId: 'b', fromAnchor: [0.5, 1], toAnchor: [0.5, 0] } },
  } as unknown as ExcalidrawElement;
  let elements = [edge], enabled = true;
  const state = { activeTool: { type: 'selection' }, zoom: { value: 1 }, scrollX: 0, scrollY: 0, offsetLeft: 0, offsetTop: 0 } as AppState;
  const update = vi.fn((patch: any) => { if (patch.elements) elements = patch.elements; Object.assign(state, patch.appState); });
  const commit = vi.fn((apply: () => void) => apply()), message = vi.fn();
  const api = { getAppState: () => state, getSceneElements: () => elements, getSceneElementsIncludingDeleted: () => elements, updateScene: update } as unknown as ExcalidrawImperativeAPI;
  cleanups.push(installConnectionBendEditing(root as unknown as HTMLElement, api, { enabled: () => enabled, commit, onMessage: message }));
  const click = (x: number, y: number, extra = {}) => { const input = event('dblclick', { clientX: x, clientY: y, ...extra }); root.dispatchEvent(input); return input; };
  return { root, win, edge, state, elements, update, commit, message, click, api, disable: () => { enabled = false; } };
}

describe('canvas connection bend gestures', () => {
  it('commits one undoable manual-route edit without changing attachments, identity, or metadata', () => {
    const { api, edge, click, update, commit, state } = fixture();
    const input = click(100, 0), edited = api.getSceneElements()[0];
    expect(input.defaultPrevented).toBe(true); expect(update).toHaveBeenCalledOnce(); expect(commit).toHaveBeenCalledOnce();
    expect(update.mock.calls[0][0].captureUpdate).toBe('IMMEDIATELY');
    expect(edited).toMatchObject({ id: 'edge', elbowed: false, fixedSegments: null, version: 2, points: [[0, 0], [100, 100]] });
    expect(edited.customData).toBe(edge.customData);
    expect((edited as any).startBinding).toBe((edge as any).startBinding); expect((edited as any).endBinding).toBe((edge as any).endBinding);
    expect(state.editingLinearElement).toMatchObject({ elementId: 'edge', isDragging: false, selectedPointsIndices: [1] });
    expect((edge as any).points).toHaveLength(3);
  });
  it('adds and then removes a draggable point at the same screen position', () => {
    const { api, click, state } = fixture(); click(50, 2);
    expect((api.getSceneElements()[0] as any).points).toEqual([[0, 0], [50, 0], [100, 0], [100, 100]]);
    expect(state.editingLinearElement?.selectedPointsIndices).toEqual([1]);
    click(50, 0); expect((api.getSceneElements()[0] as any).points).toEqual([[0, 0], [100, 0], [100, 100]]);
  });
  it('protects endpoints and preserves modified double-clicks for native shortcuts', () => {
    const { click, update } = fixture();
    expect(click(0, 0).defaultPrevented).toBe(true); expect(update).not.toHaveBeenCalled();
    expect(click(100, 0, { ctrlKey: true }).defaultPrevented).toBe(false); expect(update).not.toHaveBeenCalled();
  });
  it('leaves double-clicking label text to the text editor', () => {
    const { elements, click, update } = fixture();
    elements.push({ id: 'label', type: 'text', containerId: 'edge', x: 30, y: -10, width: 40, height: 20 } as ExcalidrawElement);
    expect(click(50, 0).defaultPrevented).toBe(false); expect(update).not.toHaveBeenCalled();
  });
  it('ignores locked objects, view mode, drawing tools, and disabled operations', () => {
    const { edge, state, click, update, disable } = fixture();
    Object.assign(edge, { locked: true }); click(100, 0); Object.assign(edge, { locked: false });
    state.viewModeEnabled = true; click(100, 0); state.viewModeEnabled = false;
    state.activeTool = { ...state.activeTool, type: 'freedraw', customType: null }; click(100, 0); state.activeTool = { ...state.activeTool, type: 'selection', customType: null };
    disable(); click(100, 0); expect(update).not.toHaveBeenCalled();
  });
  it('waits for native pointer-up to finish and suppresses the compatibility double-click', () => {
    vi.useFakeTimers(); let now = 0; vi.spyOn(performance, 'now').mockImplementation(() => now);
    const { root, win, click, update } = fixture();
    const pointer = (type: string) => win.dispatchEvent(event(type, { target: root, pointerType: 'touch', pointerId: 1, button: 0, clientX: 100, clientY: 0 }));
    pointer('pointerdown'); now = 40; pointer('pointerup');
    now = 140; pointer('pointerdown'); now = 180; pointer('pointerup');
    expect(update).not.toHaveBeenCalled(); vi.runAllTimers(); expect(update).toHaveBeenCalledOnce();
    expect(click(100, 0).defaultPrevented).toBe(true); expect(update).toHaveBeenCalledOnce();
  });
  it('cleans up listeners and queued edits when the board closes', () => {
    vi.useFakeTimers();
    const { root, win, click, update } = fixture();
    const pointer = (type: string) => win.dispatchEvent(event(type, { target: root, pointerType: 'touch', pointerId: 1, button: 0, clientX: 100, clientY: 0 }));
    pointer('pointerdown'); pointer('pointerup'); pointer('pointerdown'); pointer('pointerup');
    cleanups.pop()!(); vi.runAllTimers(); click(100, 0); expect(update).not.toHaveBeenCalled();
  });
});
