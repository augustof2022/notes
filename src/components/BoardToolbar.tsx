import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { CaptureUpdateAction } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI, ToolType } from '@excalidraw/excalidraw/types';
import { ArrowRight, BookOpen, ChevronDown, Circle, Diamond, EyeOff, Frame, GitBranch, Grid2X2, Hand, Image, Link, LockKeyhole, Magnet, Minus, MoreHorizontal, MousePointer2, Pencil, Radio, ScanText, Shapes, Square, Stamp, Type, UnlockKeyhole, type LucideIcon } from 'lucide-react';
import { SnapControls } from './SnapControls';
import type { SnapMode } from '../lib/snapping';
import './board-toolbar.css';

type ShapeType = 'rectangle' | 'diamond' | 'ellipse' | 'arrow' | 'line';
const SHAPES: { type: ShapeType; title: string; icon: LucideIcon; shortcut: string }[] = [
  { type: 'rectangle', title: 'Rectangle', icon: Square, shortcut: 'R' },
  { type: 'diamond', title: 'Diamond', icon: Diamond, shortcut: 'D' },
  { type: 'ellipse', title: 'Ellipse', icon: Circle, shortcut: 'O' },
  { type: 'arrow', title: 'Arrow', icon: ArrowRight, shortcut: 'A' },
  { type: 'line', title: 'Line', icon: Minus, shortcut: 'L' },
];
const SHAPE_KEY = 'note-toolbar-last-shape';
const readShape = (): ShapeType => { try { const value = localStorage.getItem(SHAPE_KEY); return SHAPES.some(shape => shape.type === value) ? value as ShapeType : 'rectangle'; } catch { return 'rectangle'; } };
const COMPACT_WIDTH = 640;

export interface BoardToolbarProps {
  api: ExcalidrawImperativeAPI; root: HTMLElement | null;
  zoomLocked: boolean; onZoomLock: () => void;
  snapMode: SnapMode; gridSize: number; onSnapMode: (mode: SnapMode) => void; onGridSize: (size: number) => void;
  onReadText: () => void; onHideToolbars: () => void;
}

/**
 * The board's single tool bar: pick a tool, insert something, or open More for
 * everything else (view, board, and less common tools), in that order. Tool
 * extensions (eraser modes, stamps, diagrams, object locks) render into the
 * named slots below.
 */
export function BoardToolbar({ api, root, zoomLocked, onZoomLock, snapMode, gridSize, onSnapMode, onGridSize, onReadText, onHideToolbars }: BoardToolbarProps) {
  const [active, setActive] = useState(api.getAppState().activeTool);
  const [shape, setShape] = useState<ShapeType>(readShape);
  const [open, setOpen] = useState<'shapes' | 'more' | null>(null);
  const [compact, setCompact] = useState(false);
  const bar = useRef<HTMLDivElement>(null);
  useEffect(() => api.onChange((_elements, state) => {
    setActive(previous => previous.type === state.activeTool.type && previous.customType === state.activeTool.customType && previous.locked === state.activeTool.locked ? previous : state.activeTool);
    root?.setAttribute('data-editor-overlay', String(!!state.openDialog));
    root?.setAttribute('data-editor-menu', state.openMenu || '');
  }), [api, root]);
  useLayoutEffect(() => {
    if (!root) return;
    const measure = () => setCompact(root.clientWidth < COMPACT_WIDTH);
    measure(); const observer = new ResizeObserver(measure); observer.observe(root);
    return () => { observer.disconnect(); root.removeAttribute('data-editor-overlay'); root.removeAttribute('data-editor-menu'); };
  }, [root]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!bar.current?.contains(event.target as Node) && !(event.target as Element).closest?.('.modal-backdrop')) setOpen(null); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(null); } };
    document.addEventListener('pointerdown', outside, true); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('pointerdown', outside, true); document.removeEventListener('keydown', key, true); };
  }, [open]);
  function focusCanvas() { root?.querySelector<HTMLElement>('.excalidraw')?.focus(); }
  function choose(type: ToolType, pointerType?: string) {
    setOpen(null);
    api.setActiveTool(type === 'image' ? { type, insertOnCanvasDirectly: pointerType !== 'mouse' } : { type });
    focusCanvas();
  }
  function chooseShape(type: ShapeType) {
    setShape(type); try { localStorage.setItem(SHAPE_KEY, type); } catch { /* optional */ }
    choose(type);
  }
  /** Run a slotted control that compact mode keeps out of the bar. */
  function press(selector: string) { setOpen(null); root?.querySelector<HTMLButtonElement>(selector)?.click(); }
  const is = (type: string) => active.type === type;
  const tool = (type: ToolType, title: string, Icon: LucideIcon, shortcut?: string, className = '') =>
    <button type="button" className={`note-tool ${className}`} aria-label={title} aria-pressed={is(type)} title={`${title}${shortcut ? ` (${shortcut})` : ''}`} onClick={event => choose(type, (event.nativeEvent as PointerEvent).pointerType)}><Icon size={18} /></button>;
  const item = (label: string, icon: ReactNode, onClick: () => void, options: { pressed?: boolean; hint?: string; className?: string } = {}) =>
    <button type="button" role="menuitem" className={`note-menu-item ${options.className || ''}`} aria-pressed={options.pressed} onClick={onClick}>{icon}<span>{label}</span>{options.hint && <kbd>{options.hint}</kbd>}</button>;
  const current = SHAPES.find(entry => entry.type === shape)!, shapeActive = SHAPES.some(entry => is(entry.type));
  const ShapeIcon = shapeActive ? SHAPES.find(entry => is(entry.type))!.icon : current.icon;
  const sep = <span className="note-toolbar-sep" aria-hidden="true" />;
  return <div ref={bar} className="note-toolbar" role="toolbar" aria-label="Board tools" data-compact={compact}>
    {tool('selection', 'Select', MousePointer2, 'V')}
    {tool('hand', 'Pan', Hand, 'H', 'note-wide-only')}
    {sep}
    {tool('freedraw', 'Draw', Pencil, 'P')}
    <div className="note-toolbar-slot" data-toolbar-slot="actions-writing" />
    {tool('text', 'Text', Type, 'T')}
    {sep}
    <div className="note-split" data-active={shapeActive}>
      <button type="button" className="note-tool" aria-label={`${current.title} shape`} aria-pressed={shapeActive} title={`${current.title} (${current.shortcut})`} onClick={() => chooseShape(shapeActive ? SHAPES.find(entry => is(entry.type))!.type : shape)}><ShapeIcon size={18} /></button>
      <button type="button" className="note-split-more" aria-label="All shapes" aria-haspopup="menu" aria-expanded={open === 'shapes'} title="Rectangle, diamond, ellipse, arrow, line" onClick={() => setOpen(open === 'shapes' ? null : 'shapes')}><ChevronDown size={13} /></button>
      <div className="note-popover note-shapes" role="menu" aria-label="Shapes" data-open={open === 'shapes'}>
        {SHAPES.map(entry => item(entry.title, <entry.icon size={17} />, () => chooseShape(entry.type), { pressed: is(entry.type), hint: entry.shortcut }))}
      </div>
    </div>
    {sep}
    {tool('image', 'Image', Image, '9')}
    <div className="note-toolbar-slot note-wide-only" data-toolbar-slot="actions-stamps" />
    <div className="note-toolbar-slot note-wide-only" data-toolbar-slot="actions-diagrams" />
    {sep}
    <div className="note-more">
      <button type="button" className="note-tool" aria-label="More tools and options" aria-haspopup="menu" aria-expanded={open === 'more'} title="More tools, view, and board options" onClick={() => setOpen(open === 'more' ? null : 'more')}><MoreHorizontal size={18} /></button>
      <div className="note-popover note-more-panel" role="menu" aria-label="More" data-open={open === 'more'} onClick={event => { if ((event.target as Element).closest('.note-menu-item, .note-toolbar-slot button:not([aria-haspopup="dialog"]):not(.snap-mode-button)')) setOpen(null); }}>
        <p className="note-menu-heading">Insert</p>
        {compact && item('Icon stamp', <Stamp size={17} />, () => press('.icon-stamp-trigger'), { hint: 'I' })}
        {compact && item('Choose stamp icon', <Stamp size={17} />, () => press('.icon-stamp-picker-trigger'))}
        {compact && item('Diagrams', <Shapes size={17} />, () => press('.diagram-mode-button'))}
        {item('Frame', <Frame size={17} />, () => choose('frame'), { pressed: is('frame'), hint: 'F' })}
        {item('Web embed', <Link size={17} />, () => choose('embeddable'), { pressed: is('embeddable') })}
        {item('Mermaid to diagram', <GitBranch size={17} />, () => { setOpen(null); api.updateScene({ appState: { openDialog: { name: 'ttd', tab: 'mermaid' } }, captureUpdate: CaptureUpdateAction.NEVER }); })}
        {item('Shape library', <BookOpen size={17} />, () => { setOpen(null); api.updateScene({ appState: { openSidebar: { name: 'default', tab: 'library' } }, captureUpdate: CaptureUpdateAction.NEVER }); })}
        <p className="note-menu-heading">Tools</p>
        {compact && item('Pan', <Hand size={17} />, () => choose('hand'), { pressed: is('hand'), hint: 'H' })}
        {item('Laser pointer', <Radio size={17} />, () => choose('laser'), { pressed: is('laser'), hint: 'K' })}
        {item('Keep tool active', active.locked ? <LockKeyhole size={17} /> : <UnlockKeyhole size={17} />, () => api.updateScene({ appState: { activeTool: { ...api.getAppState().activeTool, locked: !active.locked } }, captureUpdate: CaptureUpdateAction.NEVER }), { pressed: active.locked, hint: 'Q' })}
        <p className="note-menu-heading">View</p>
        {item(zoomLocked ? 'Zoom locked' : 'Lock zoom', zoomLocked ? <LockKeyhole size={17} /> : <UnlockKeyhole size={17} />, onZoomLock, { pressed: zoomLocked })}
        <div className="note-segmented" role="group" aria-label="Snapping">
          <span>{snapMode === 'grid' ? <Grid2X2 size={16} /> : <Magnet size={16} />}Snap</span>
          {(['off', 'elements', 'grid'] as const).map(mode => <button key={mode} type="button" aria-pressed={snapMode === mode} onClick={() => onSnapMode(mode)}>{mode === 'off' ? 'Off' : mode === 'elements' ? 'Objects' : 'Grid'}</button>)}
        </div>
        <div className="note-grid-size"><SnapControls controls="size" mode={snapMode} size={gridSize} onModeChange={onSnapMode} onSizeChange={onGridSize} /></div>
        <p className="note-menu-heading">Board</p>
        {item('Read text in images & handwriting', <ScanText size={17} />, onReadText)}
        <div className="note-toolbar-slot note-menu-slot" data-toolbar-slot="actions-unlock" />
        {item('Hide toolbars', <EyeOff size={17} />, onHideToolbars)}
      </div>
    </div>
  </div>;
}
