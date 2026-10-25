import { useEffect, useState } from 'react';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI, ToolType } from '@excalidraw/excalidraw/types';
import { ArrowRight, Circle, Diamond, Eraser, Frame, Hand, Image, Link, LockKeyhole, Minus, MousePointer2, Pencil, Radio, Square, GitBranch, Type, UnlockKeyhole, type LucideIcon } from 'lucide-react';
import { FloatingToolbar } from './FloatingToolbar';
import { PARTIAL_ERASER_TOOL } from '../lib/ink-scene';

const tools: { type: ToolType; title: string; icon: LucideIcon; shortcut?: string }[] = [
  { type: 'selection', title: 'Select', icon: MousePointer2, shortcut: 'V / 1' },
  { type: 'rectangle', title: 'Rectangle', icon: Square, shortcut: 'R / 2' },
  { type: 'diamond', title: 'Diamond', icon: Diamond, shortcut: 'D / 3' },
  { type: 'ellipse', title: 'Ellipse', icon: Circle, shortcut: 'O / 4' },
  { type: 'arrow', title: 'Arrow', icon: ArrowRight, shortcut: 'A / 5' },
  { type: 'line', title: 'Line', icon: Minus, shortcut: 'L / 6' },
  { type: 'freedraw', title: 'Draw', icon: Pencil, shortcut: 'P / 7' },
  { type: 'text', title: 'Text', icon: Type, shortcut: 'T / 8' },
  { type: 'image', title: 'Image', icon: Image, shortcut: '9' },
  { type: 'eraser', title: 'Eraser', icon: Eraser, shortcut: 'E / 0' },
  { type: 'hand', title: 'Hand', icon: Hand, shortcut: 'H' },
  { type: 'frame', title: 'Frame', icon: Frame, shortcut: 'F' },
  { type: 'embeddable', title: 'Embed', icon: Link },
  { type: 'laser', title: 'Laser pointer', icon: Radio, shortcut: 'K' },
];
export function DrawingToolbar({ api, root }: { api: ExcalidrawImperativeAPI; root: HTMLElement | null }) {
  const [active, setActive] = useState(api.getAppState().activeTool);
  const [overlay, setOverlay] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  useEffect(() => api.onChange((_elements, state) => {
    setActive(previous => previous.type === state.activeTool.type && previous.customType === state.activeTool.customType && previous.locked === state.activeTool.locked ? previous : state.activeTool);
    setOverlay(!!state.openDialog); setMenu(state.openMenu);
  }), [api]);
  useEffect(() => {
    root?.setAttribute('data-editor-overlay', String(overlay));
    return () => root?.removeAttribute('data-editor-overlay');
  }, [root, overlay]);
  useEffect(() => {
    root?.setAttribute('data-editor-menu', menu || '');
    return () => root?.removeAttribute('data-editor-menu');
  }, [root, menu]);
  function choose(type: ToolType, pointerType?: string) {
    api.setActiveTool(type === 'image' ? { type, insertOnCanvasDirectly: pointerType !== 'mouse' } : { type });
    root?.querySelector<HTMLElement>('.excalidraw')?.focus();
  }
  return <FloatingToolbar group="drawing" title="Drawing tools" root={root} items={[
    ...tools.map(({ type, title, icon: Icon, shortcut }) => ({ id: type, title, content: <button aria-label={title} aria-pressed={active.type === type || (type === 'eraser' && active.type === 'custom' && active.customType === PARTIAL_ERASER_TOOL)} title={`${title}${shortcut ? ` (${shortcut})` : ''}`} onClick={event => choose(type, (event.nativeEvent as PointerEvent).pointerType)}><Icon size={17} /><span>{title}</span></button> })),
    { id: 'mermaid', title: 'Mermaid to diagram', content: <button aria-label="Mermaid to diagram" title="Create a diagram from Mermaid code" onClick={() => api.updateScene({ appState: { openDialog: { name: 'ttd', tab: 'mermaid' } }, captureUpdate: CaptureUpdateAction.NEVER })}><GitBranch size={17} /><span>Mermaid to diagram</span></button> },
    { id: 'tool-lock', title: 'Keep tool active', content: <button aria-label="Keep tool active" title="Keep the current drawing tool active after drawing (Q)" aria-pressed={active.locked} onClick={() => api.updateScene({ appState: { activeTool: { ...api.getAppState().activeTool, locked: !active.locked } }, captureUpdate: CaptureUpdateAction.NEVER })}>{active.locked ? <LockKeyhole size={17} /> : <UnlockKeyhole size={17} />}<span>Keep tool active</span></button> },
  ]} />;
}
