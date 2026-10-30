import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { createPortal, flushSync } from 'react-dom';
import { CaptureUpdateAction, convertToExcalidrawElements, exportToClipboard, mutateElement } from '@excalidraw/excalidraw';
import type { ExcalidrawElement, ExcalidrawTextElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { Code, Image, Type } from 'lucide-react';
import { applyRichText, richTextWidth, selectedText } from '../lib/rich-text-scene';
import { plainRichDoc, readRichText, richDocText, withRichTextRenders, type RichDoc } from '../lib/rich-text';
import { readDiagramData } from '../lib/diagram-model';
import type { DiagramShortcutRelation } from '../lib/diagram-shortcuts';
import { RichTextEditor } from './RichTextEditor';

export interface RichTextHandle { flush(): void; finish(): void; draftElements(): ExcalidrawElement[] | null; hasDraft(): boolean }
interface Session { base: ExcalidrawTextElement; doc: RichDoc; color: string; selectAll: boolean; diagram: boolean; applied: string; width: number; undoCreation: boolean }
export const RichTextTools = forwardRef<RichTextHandle, { api: ExcalidrawImperativeAPI; root: HTMLDivElement | null }>(function RichTextTools({ api, root }, ref) {
  const [session, setSession] = useState<Session | null>(null), current = useRef<Session | null>(null);
  const [host, setHost] = useState<Element | null>(null);
  const [editorHeight, setEditorHeight] = useState(27), [, updateViewport] = useState('');
  const takingOver = useRef(false);
  const createdNode = useRef<string | null>(null);
  useEffect(() => {
    const created = (event: Event) => { createdNode.current = (event as CustomEvent<{ nodeId: string }>).detail.nodeId; };
    root?.addEventListener('note-diagram-node-created', created);
    return () => root?.removeEventListener('note-diagram-node-created', created);
  }, [root]);
  useLayoutEffect(() => { setHost(root?.querySelector('[data-toolbar-slot="actions-text"]') || null); }, [root]);
  useLayoutEffect(() => {
    if (!root) return;
    root.toggleAttribute('data-inline-editing', !!session);
    return () => root.removeAttribute('data-inline-editing');
  }, [root, !!session]);
  useEffect(() => api.onChange((_elements, state) => {
    updateViewport(`${state.scrollX}:${state.scrollY}:${state.zoom.value}:${state.offsetLeft}:${state.offsetTop}:${state.width}:${state.height}`);
  }), [api]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (current.current && !(event.target instanceof Element && event.target.closest('[data-inline-text-editor]'))) finish(current.current.doc, undefined, false);
    };
    document.addEventListener('pointerdown', outside, true);
    return () => document.removeEventListener('pointerdown', outside, true);
  }, [api, root]);
  useEffect(() => {
    for (const type of ['png', 'svg'] as const) api.registerAction({
      name: type === 'png' ? 'copyAsPng' : 'copyAsSvg', label: type === 'png' ? 'labels.copyAsPng' : 'labels.copyAsSvg',
      icon: type === 'png' ? <Image size={16} /> : <Code size={16} />, trackEvent: false,
      ...(type === 'png' ? { keyTest: (event: KeyboardEvent | React.KeyboardEvent) => event.code === 'KeyC' && event.altKey && event.shiftKey } : {}),
      predicate: elements => elements.some(element => !element.isDeleted) && (type === 'png' ? typeof ClipboardItem !== 'undefined' && !!navigator.clipboard?.write : !!navigator.clipboard?.writeText),
      perform: async (_elements, state, _data, app) => {
        const all = api.getSceneElements(), selected = app.scene.getSelectedElements({ selectedElementIds: state.selectedElementIds, includeBoundTextElement: true, includeElementsInFrames: true });
        const primary = all.filter(element => state.selectedElementIds[element.id] && !element.customData?.noteRichTextRender);
        const frame = primary.length === 1 && (primary[0].type === 'frame' || primary[0].type === 'magicframe') ? primary[0] : null;
        try {
          await exportToClipboard({ type, elements: selected.length ? withRichTextRenders(all, selected) : all, appState: state, files: api.getFiles(), exportingFrame: frame,
            getDimensions: (width: number, height: number) => ({ width, height, scale: state.exportScale }) });
          api.setToast({ message: `Copied ${selected.length ? 'selection' : 'board'} as ${type.toUpperCase()}.` });
        } catch (error) { api.setToast({ message: error instanceof Error ? error.message : 'Could not copy this image.' }); }
        return false as const;
      },
    });
  }, [api]);
  function start(base: ExcalidrawTextElement, selectAll = false) {
    const data = readRichText(base), container = api.getSceneElements().find(element => element.id === base.containerId);
    const doc = data?.doc || plainRichDoc(base.originalText);
    const deleted = api.getSceneElementsIncludingDeleted().find(element => element.id === base.id)?.isDeleted;
    const state = api.getAppState(), zoom = state.zoom.value;
    let width = Math.min(2400, base.containerId ? richTextWidth(base, api.getSceneElements()) : data || !base.autoResize ? Math.max(48, base.width) : Math.max(320, base.width));
    const originX = container && ['rectangle', 'ellipse', 'diamond'].includes(container.type) ? container.x + (container.width - width) / 2 : base.x;
    const left = (originX + state.scrollX) * zoom;
    if (!base.containerId) width = Math.max(48, Math.min(width, (state.width - 16) / zoom, !data && base.autoResize ? (state.width - left - 16) / zoom : Infinity));
    const targetLeft = Math.max(8, Math.min(left, state.width - width * zoom - 8));
    const undoCreation = !!container && createdNode.current === container.id; createdNode.current = null;
    const next = { base: structuredClone(base), doc, color: data?.color || base.strokeColor, selectAll, diagram: readDiagramData(container || base)?.kind === 'node', applied: data && deleted ? '' : JSON.stringify(doc), width, undoCreation };
    current.current = next; setEditorHeight(base.height || base.fontSize * 1.35); setSession(next);
    api.updateScene({ appState: { editingTextElement: { ...base, isDeleted: false }, selectedElementIds: {}, selectedGroupIds: {}, openMenu: null, scrollX: state.scrollX + (targetLeft - left) / zoom }, captureUpdate: CaptureUpdateAction.NEVER });
  }
  function draftScene() {
    const active = current.current; if (!active) return null;
    const signature = JSON.stringify(active.doc); if (signature === active.applied) return null;
    const elements: ExcalidrawElement[] = [...api.getSceneElementsIncludingDeleted()];
    const index = elements.findIndex(element => element.id === active.base.id), existing = elements[index];
    // Pass a replacement to updateScene. Mutating the live scene first makes
    // the editor classify that change as an unfinished native edit, losing Undo.
    const text = structuredClone(existing?.type === 'text' ? existing : active.base);
    if (index < 0) elements.push(text); else elements[index] = text;
    mutateElement(text, { width: active.width }, false);
    applyRichText(text, active.doc, active.color, true);
    if (!readRichText(text)) {
      const [measured] = convertToExcalidrawElements([{ type: 'text', text: richDocText(active.doc), x: text.x, y: text.y,
        fontSize: text.fontSize, fontFamily: text.fontFamily, textAlign: text.textAlign, verticalAlign: text.verticalAlign,
        ...(text.containerId ? { width: richTextWidth(text, elements), autoResize: false } : {}) }]);
      if (measured.type === 'text') mutateElement(text, { width: measured.width, height: measured.height, text: measured.text }, false);
    } else if (text.width < 48 && !text.containerId) mutateElement(text, { width: 360 }, false);
    const container = elements.find(element => element.id === text.containerId && !element.isDeleted);
    if (container && !text.isDeleted) {
      const replacement = structuredClone(container);
      const meta = readDiagramData(container);
      if (meta?.kind === 'node' && !readDiagramData(text)) mutateElement(text, { customData: { ...text.customData, noteDiagram: { kind: 'decoration', nodeId: container.id, diagramId: meta.diagramId, system: meta.system } } }, false);
      if (!container.boundElements?.some(bound => bound.id === text.id)) mutateElement(replacement, { boundElements: [...(container.boundElements || []), { id: text.id, type: 'text' }] }, false);
      if (!readRichText(text) && ['rectangle', 'ellipse', 'diamond'].includes(container.type)) {
        const factor = container.type === 'ellipse' ? Math.SQRT1_2 : container.type === 'diamond' ? 0.5 : 1;
        const height = Math.max(container.height, (text.height + 10) / factor), inset = (height - height * factor) / 2 + 5;
        mutateElement(replacement, { height }, false);
        mutateElement(text, { x: container.x + (container.width - text.width) / 2,
          y: text.verticalAlign === 'top' ? container.y + inset : text.verticalAlign === 'bottom' ? container.y + height - inset - text.height : container.y + (height - text.height) / 2 }, false);
      } else if (!readRichText(text) && container.type === 'arrow') {
        const old = existing?.type === 'text' ? existing : active.base;
        mutateElement(text, { x: old.x + (old.width - text.width) / 2, y: old.y + (old.height - text.height) / 2 }, false);
      }
      elements[elements.indexOf(container)] = replacement;
    }
    if (text.isDeleted) for (let position = 0; position < elements.length; position++) {
      const element = elements[position]; if (element.id === text.id || element.isDeleted) continue;
      const updates: Record<string, unknown> = {};
      if (element.boundElements?.some(bound => bound.id === text.id)) updates.boundElements = element.boundElements.filter(bound => bound.id !== text.id);
      if (element.type === 'arrow') {
        if (element.startBinding?.elementId === text.id) updates.startBinding = null;
        if (element.endBinding?.elementId === text.id) updates.endBinding = null;
      }
      if (Object.keys(updates).length) { const replacement = structuredClone(element); mutateElement(replacement, updates, false); elements[position] = replacement; }
    }
    return { elements, text, active, signature };
  }
  function saveDraft() {
    const draft = draftScene(); if (!draft) return;
    api.updateScene({ elements: draft.elements, appState: { editingTextElement: draft.text.isDeleted ? null : { ...draft.text, isDeleted: false }, selectedElementIds: {}, selectedGroupIds: {}, openMenu: null }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    draft.active.applied = draft.signature;
    draft.active.undoCreation = false;
  }
  function undoCreation() {
    if (!current.current?.undoCreation) return false;
    flushSync(() => {
      current.current = null; setSession(null);
      api.updateScene({ appState: { editingTextElement: null }, captureUpdate: CaptureUpdateAction.NEVER });
    });
    const canvas = root?.querySelector<HTMLElement>('.excalidraw'); canvas?.focus();
    canvas?.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, metaKey: true, bubbles: true, cancelable: true }));
    return true;
  }
  useImperativeHandle(ref, () => ({ flush: saveDraft, finish: () => { if (current.current) finish(current.current.doc, undefined, false); }, draftElements: () => draftScene()?.elements || null, hasDraft: () => !!current.current }));
  function finish(doc: RichDoc, relation?: DiagramShortcutRelation, focusCanvas = true) {
    if (!current.current) return;
    const id = current.current.base.id;
    current.current.doc = doc;
    flushSync(() => {
      saveDraft(); current.current = null; setSession(null);
      const text = api.getSceneElements().find(element => element.id === id);
      api.updateScene({ appState: { editingTextElement: null, selectedElementIds: text ? { [text.type === 'text' && text.containerId || text.id]: true } : {} }, captureUpdate: CaptureUpdateAction.NEVER });
    });
    const canvas = root?.querySelector<HTMLElement>('.excalidraw'); if (focusCanvas) canvas?.focus();
    if (relation) canvas?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', shiftKey: relation === 'sibling', bubbles: true, cancelable: true }));
  }
  useEffect(() => {
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const takeOver = () => {
      if (takingOver.current || current.current || root.inert) return;
      const state = api.getAppState(), input = root.querySelector<HTMLTextAreaElement>('textarea.excalidraw-wysiwyg');
      const element = state.editingTextElement;
      if (!input || element?.type !== 'text' || element.locked || state.viewModeEnabled) return;
      const latest = api.getSceneElementsIncludingDeleted().find(item => item.id === element.id);
      if (latest?.type !== 'text') return;
      takingOver.current = true;
      try {
        // Close the native editor through its public keyboard behavior. Keeping
        // its hidden textarea alive would steal focus on every scene update.
        const all = input.value.length > 0 && input.selectionStart === 0 && input.selectionEnd === input.value.length;
        const saved = structuredClone(latest);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', ctrlKey: true, metaKey: true, cancelable: true }));
        flushSync(() => start(saved, all));
      } finally { takingOver.current = false; }
    };
    const schedule = () => { if (timer) clearTimeout(timer); timer = setTimeout(takeOver, 0); };
    const unsubscribe = api.onChange(schedule);
    root.addEventListener('note-rich-text-edit', takeOver);
    const observer = new MutationObserver(schedule); observer.observe(root, { childList: true, subtree: true }); schedule();
    return () => { if (timer) clearTimeout(timer); unsubscribe(); observer.disconnect(); root.removeEventListener('note-rich-text-edit', takeOver); };
  }, [api, root]);
  function formatSelected() {
    if (current.current) return;
    root?.dispatchEvent(new Event('note-board-tool-activate'));
    const state = api.getAppState(), text = selectedText(api.getSceneElements(), state.selectedElementIds);
    if (text) { start(text); return; }
    const selected = api.getSceneElements().filter(element => state.selectedElementIds[element.id] && !element.locked);
    if (selected.length === 1 && ['rectangle', 'ellipse', 'diamond', 'arrow'].includes(selected[0].type)) {
      const canvas = root?.querySelector<HTMLElement>('.excalidraw'); canvas?.focus();
      canvas?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', bubbles: true, cancelable: true }));
    } else api.setActiveTool({ type: 'text' });
  }
  const state = api.getAppState(), liveText = session && api.getSceneElements().find(element => element.id === session.base.id);
  const parent = session && api.getSceneElements().find(element => element.id === session.base.containerId);
  const geometry = liveText?.type === 'text' ? liveText : session?.base;
  let x = geometry?.x || 0, y = geometry?.y || 0;
  if (session && parent && ['rectangle', 'ellipse', 'diamond'].includes(parent.type)) {
    x = parent.x + (parent.width - session.width) / 2;
    if (session.base.verticalAlign === 'middle') y = parent.y + (parent.height - editorHeight) / 2;
    else if (session.base.verticalAlign === 'bottom') y = parent.y + parent.height - editorHeight - 5;
  }
  return <>
    {host && createPortal(<button aria-label="Text and formatting" title="Add text, or format selected text and diagram labels" onClick={formatSelected}><Type size={15} /><span>Format text</span></button>, host)}
    {session && createPortal(<RichTextEditor key={session.base.id} doc={session.doc} fontSize={session.base.fontSize} color={session.color} opacity={session.base.opacity / 100} textAlign={session.base.textAlign === 'center' ? 'center' : session.base.textAlign === 'right' ? 'right' : 'left'} diagram={session.diagram} selectAll={session.selectAll}
      position={{ left: state.offsetLeft + (x + state.scrollX) * state.zoom.value, top: state.offsetTop + (y + state.scrollY) * state.zoom.value }} width={session.width} zoom={state.zoom.value} angle={parent && parent.type !== 'arrow' ? parent.angle : session.base.angle} minHeight={session.base.fontSize * 1.35}
      boardBounds={{ left: state.offsetLeft, top: state.offsetTop, right: state.offsetLeft + state.width, bottom: state.offsetTop + state.height }} onCaretPan={(dx, dy) => { const currentState = api.getAppState(); api.updateScene({ appState: { scrollX: currentState.scrollX + dx / currentState.zoom.value, scrollY: currentState.scrollY + dy / currentState.zoom.value }, captureUpdate: CaptureUpdateAction.NEVER }); }}
      undoCreation={session.undoCreation} onUndoCreation={undoCreation} onHeight={setEditorHeight} onDraft={doc => { if (current.current) { current.current.doc = doc; root?.dispatchEvent(new Event('note-rich-text-change')); } }} onApply={finish} />, document.body)}
  </>;
});
