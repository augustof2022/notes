import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { AllSelection, Selection } from '@tiptap/pm/state';
import { Bold, Italic, Underline, Strikethrough, Link2, Check, X } from 'lucide-react';
import { cleanRichDoc, clipboardRichDoc, richTextExtensions, safeTextLink, type RichDoc } from '../lib/rich-text';
import { diagramShortcutRelation, type DiagramShortcutRelation } from '../lib/diagram-shortcuts';
import { slashMatch, textCommands, textPopupPosition, type SlashMatch, type TextCommand } from '../lib/text-commands';
import './rich-text.css';

type Popup = { left: number; top: number };
export function RichTextEditor({ doc, fontSize, color, opacity, textAlign, diagram, selectAll, position, width, zoom, angle, minHeight, boardBounds, undoCreation, onUndoCreation, onApply, onDraft, onHeight, onCaretPan }: {
  doc: RichDoc; fontSize: number; color: string; textAlign: 'left' | 'center' | 'right'; diagram: boolean; selectAll: boolean;
  position: Popup; width: number; zoom: number; angle: number; minHeight: number; opacity: number;
  boardBounds: { left: number; top: number; right: number; bottom: number }; onCaretPan: (dx: number, dy: number) => void;
  undoCreation: boolean; onUndoCreation: () => boolean;
  onApply: (doc: RichDoc, relation?: DiagramShortcutRelation, focusCanvas?: boolean) => void; onDraft: (doc: RichDoc) => void; onHeight: (height: number) => void;
}) {
  const surface = useRef<HTMLDivElement>(null), editorRef = useRef<ReturnType<typeof useEditor>>(null);
  const draft = useRef(doc), pasteMode = useRef({ raw: false, at: 0 }), dismissed = useRef<number | null>(null);
  const initialDoc = useRef(JSON.stringify(cleanRichDoc(doc)));
  const [slash, setSlash] = useState<SlashMatch | null>(null), slashRef = useRef<SlashMatch | null>(null);
  const [active, setActive] = useState(0), activeRef = useRef(0);
  const [menuPosition, setMenuPosition] = useState<Popup>({ left: 8, top: 8 }), [barPosition, setBarPosition] = useState<Popup | null>(null);
  const [link, setLink] = useState<string | null>(null), linkRef = useRef<string | null>(null), [linkError, setLinkError] = useState('');
  const [, refresh] = useState(0);
  const panPending = useRef(false);
  const latest = useRef({ onApply, onDraft, onHeight, onCaretPan, boardBounds, undoCreation, onUndoCreation }); latest.current = { onApply, onDraft, onHeight, onCaretPan, boardBounds, undoCreation, onUndoCreation };
  const finish = (relation?: DiagramShortcutRelation, focusCanvas = true) => latest.current.onApply(cleanRichDoc(draft.current), relation, focusCanvas);
  const viewport = () => ({ width: window.visualViewport?.width || innerWidth, height: window.visualViewport?.height || innerHeight, left: window.visualViewport?.offsetLeft || 0, top: window.visualViewport?.offsetTop || 0 });
  function updateControls() {
    const current = editorRef.current; if (!current || current.isDestroyed) return;
    const { selection } = current.state;
    const before = selection.$from.parent.textBetween(0, selection.$from.parentOffset, '\n', '\ufffc');
    const match = selection.empty ? slashMatch(before, selection.from, current.isActive('codeBlock') || current.isActive('code')) : null;
    if (!match) dismissed.current = null;
    const next = match && match.from !== dismissed.current && textCommands(match.query).length ? match : null;
    if (next?.query !== slashRef.current?.query || next?.from !== slashRef.current?.from) { activeRef.current = 0; setActive(0); }
    slashRef.current = next; setSlash(next);
    const coords = current.view.coordsAtPos(selection.from), screen = viewport();
    if (selection.empty && current.view.hasFocus() && !panPending.current) {
      const bounds = latest.current.boardBounds, left = Math.max(bounds.left, screen.left) + 12, right = Math.min(bounds.right, screen.left + screen.width) - 12;
      const bottom = Math.min(bounds.bottom, screen.top + screen.height) - 60, top = Math.min(Math.max(bounds.top, screen.top) + 120, bottom - 50);
      const dx = coords.left < left ? left - coords.left : coords.right > right ? right - coords.right : 0;
      const dy = coords.top < top ? top - coords.top : coords.bottom > bottom ? bottom - coords.bottom : 0;
      if (Math.abs(dx) > 1 || Math.abs(dy) > 1) {
        panPending.current = true; latest.current.onCaretPan(dx, dy); requestAnimationFrame(() => { panPending.current = false; });
      }
    }
    if (next) setMenuPosition(textPopupPosition(coords, { width: Math.min(270, screen.width - 16), height: Math.min(textCommands(next.query).length * 42 + 12, 300, screen.height - 24) }, screen));
    if (!selection.empty && current.state.doc.textBetween(selection.from, selection.to).trim()) {
      const end = current.view.coordsAtPos(selection.to);
      setBarPosition(textPopupPosition({ left: Math.min(coords.left, end.left), top: Math.min(coords.top, end.top), bottom: Math.max(coords.bottom, end.bottom) }, { width: Math.min(264, screen.width - 16), height: 42 }, screen, true));
    } else setBarPosition(null);
    refresh(value => value + 1);
  }
  function command(id: TextCommand) {
    const current = editorRef.current, match = slashRef.current; if (!current || !match) return;
    dismissed.current = match.from;
    const chain = current.chain().deleteRange({ from: match.from, to: match.to });
    if (id === 'bold' || id === 'italic' || id === 'underline' || id === 'strike') chain.toggleMark(id).run();
    else if (id === 'paragraph') chain.clearNodes().setParagraph().run();
    else if (id === 'h1' || id === 'h2' || id === 'h3') chain.clearNodes().setHeading({ level: Number(id[1]) as 1 | 2 | 3 }).run();
    else if (id === 'bullet') chain.clearNodes().toggleBulletList().run();
    else if (id === 'number') chain.clearNodes().toggleOrderedList().run();
    else if (id === 'check') chain.clearNodes().toggleTaskList().run();
    else if (id === 'quote') chain.clearNodes().toggleBlockquote().run();
    else if (id === 'code') chain.clearNodes().setCodeBlock().run();
    else chain.setHorizontalRule().run();
    slashRef.current = null; setSlash(null); current.view.focus();
  }
  const editor = useEditor({
    extensions: richTextExtensions(), content: doc, immediatelyRender: true,
    onUpdate: ({ editor: updated }) => { draft.current = cleanRichDoc(updated.getJSON()); latest.current.onDraft(draft.current); },
    onTransaction: () => { if (editorRef.current) updateControls(); },
    editorProps: {
      attributes: { class: 'note-rich-content', role: 'textbox', 'aria-label': diagram ? 'Diagram text' : 'Text content', 'aria-multiline': 'true', spellcheck: 'true', 'data-placeholder': 'Type / for commands' },
      handleKeyDown: (_view, event) => {
        if (event.isComposing || event.keyCode === 229) return false;
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'z') {
          const current = editorRef.current;
          if (!event.shiftKey && latest.current.undoCreation && current && !current.can().undo() && JSON.stringify(cleanRichDoc(current.getJSON())) === initialDoc.current && latest.current.onUndoCreation()) {
            event.preventDefault(); event.stopPropagation(); return true;
          }
          event.preventDefault(); if (event.shiftKey) current?.commands.redo(); else current?.commands.undo(); return true;
        }
        if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'a') {
          event.preventDefault(); editorRef.current?.commands.selectAll(); return true;
        }
        const mark = ({ b: 'bold', i: 'italic', u: 'underline' } as Record<string, string>)[event.key.toLowerCase()];
        if (mark && (event.ctrlKey || event.metaKey) && !event.altKey && !event.shiftKey) {
          event.preventDefault(); editorRef.current?.commands.toggleMark(mark); return true;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') pasteMode.current = { raw: event.shiftKey, at: Date.now() };
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault(); const href = editorRef.current?.getAttributes('link').href || 'https://'; linkRef.current = href; setLink(href); setLinkError(''); return true;
        }
        const match = slashRef.current;
        if (match && !event.ctrlKey && !event.metaKey && !event.altKey) {
          const items = textCommands(match.query);
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault(); activeRef.current = (activeRef.current + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; setActive(activeRef.current); return true;
          }
          if (event.key === 'Enter' || event.key === 'Tab') { event.preventDefault(); command(items[activeRef.current]?.id || items[0].id); return true; }
          if (event.key === 'Escape') { event.preventDefault(); dismissed.current = match.from; slashRef.current = null; setSlash(null); return true; }
        }
        const relation = diagram && diagramShortcutRelation(event);
        if (relation || (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) || event.key === 'Escape') {
          event.preventDefault(); event.stopPropagation(); finish(relation || undefined); return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const raw = pasteMode.current.raw && Date.now() - pasteMode.current.at < 2000; pasteMode.current = { raw: false, at: 0 };
        const text = event.clipboardData?.getData('text/plain'); if (!text) return false;
        if (!raw && event.clipboardData?.getData('text/html')) return false;
        const parsed = clipboardRichDoc(text, raw);
        event.preventDefault();
        if (raw) editorRef.current?.chain().unsetAllMarks().insertContent(parsed).run(); else editorRef.current?.commands.insertContent(parsed);
        return true;
      },
    },
  });
  editorRef.current = editor;
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return;
    editor.view.focus(); const state = editor.state;
    editor.view.dispatch(state.tr.setSelection(selectAll ? new AllSelection(state.doc) : Selection.atEnd(state.doc)));
    const resize = new ResizeObserver(() => { latest.current.onHeight(editor.view.dom.offsetHeight); updateControls(); }); resize.observe(editor.view.dom);
    const update = () => updateControls(); window.addEventListener('resize', update); window.visualViewport?.addEventListener('resize', update);
    return () => { resize.disconnect(); window.removeEventListener('resize', update); window.visualViewport?.removeEventListener('resize', update); };
  }, [editor]);
  useLayoutEffect(() => { if (editor) updateControls(); }, [position.left, position.top, zoom, width]);
  useLayoutEffect(() => { surface.current?.querySelector('[data-command-active="true"]')?.scrollIntoView({ block: 'nearest' }); }, [active]);
  function openLink() { const href = editor?.getAttributes('link').href || 'https://'; linkRef.current = href; setLink(href); setLinkError(''); }
  const style = { left: position.left, top: position.top, width: width * zoom } as CSSProperties;
  const height = editor && !editor.isDestroyed ? editor.view.dom.offsetHeight : minHeight;
  const clipPath = `inset(${Math.max(0, (boardBounds.top - position.top) / zoom)}px ${Math.max(0, (position.left + width * zoom - boardBounds.right) / zoom)}px ${Math.max(0, (position.top + height * zoom - boardBounds.bottom) / zoom)}px ${Math.max(0, (boardBounds.left - position.left) / zoom)}px)`;
  const button = (label: string, icon: React.ReactNode, mark: string) => <button type="button" title={label} aria-label={label} aria-pressed={editor?.isActive(mark)} onMouseDown={event => event.preventDefault()} onClick={() => { editor?.chain().toggleMark(mark).run(); editor?.view.focus(); }}>{icon}</button>;
  return <div ref={surface} className="note-inline-text" data-inline-text-editor data-empty={editor?.isEmpty} style={style} onPointerDown={event => event.stopPropagation()} onBlurCapture={() => {
    requestAnimationFrame(() => { if (surface.current && !surface.current.contains(document.activeElement)) finish(undefined, false); });
  }}>
    <div className="note-inline-text-surface" style={{ width, transform: `scale(${zoom})`, clipPath, fontSize, color, opacity, textAlign, minHeight }}>
      <div style={{ transform: `rotate(${angle}rad)`, transformOrigin: 'center center' }}><EditorContent editor={editor} /></div>
    </div>
    {slash && <div className="note-text-commands" role="listbox" aria-label="Text commands" style={{ ...menuPosition, maxHeight: Math.min(300, viewport().height - 24) }} onMouseDown={event => event.preventDefault()}>
      {textCommands(slash.query).map((item, index) => <button role="option" aria-selected={active === index} data-command-active={active === index} key={item.id} onPointerEnter={() => { activeRef.current = index; setActive(index); }} onClick={() => command(item.id)}><span className="note-command-icon">{item.icon}</span><span><strong>{item.label}</strong><small>{item.hint}</small></span></button>)}
    </div>}
    {!slash && barPosition && <div className="note-text-selection-bar" role="toolbar" aria-label="Format selected text" style={barPosition}>
      {button('Bold (Ctrl+B)', <Bold size={16} />, 'bold')}{button('Italic (Ctrl+I)', <Italic size={16} />, 'italic')}{button('Underline (Ctrl+U)', <Underline size={16} />, 'underline')}{button('Strikethrough', <Strikethrough size={16} />, 'strike')}
      <label className="note-text-color" title="Text color"><span>A</span><input type="color" aria-label="Text color" defaultValue={/^#[\da-f]{6}$/i.test(color) ? color : '#1b1b1f'} onChange={event => { editor?.chain().setColor(event.target.value).run(); editor?.view.focus(); }} /></label>
      <button aria-label="Add or edit link" title="Link (Ctrl+K)" onMouseDown={event => event.preventDefault()} onClick={openLink}><Link2 size={16} /></button>
    </div>}
    {link !== null && <form className="note-text-link" style={barPosition || menuPosition} onSubmit={event => {
      event.preventDefault(); const href = safeTextLink(linkRef.current); if (!href && linkRef.current) { setLinkError('Use an https://, http://, mailto:, or tel: link.'); return; }
      if (href) editor?.chain().extendMarkRange('link').setLink({ href }).run(); else editor?.chain().extendMarkRange('link').unsetLink().run();
      linkRef.current = null; setLink(null); editor?.view.focus();
    }}><input aria-label="Link address" value={link} autoFocus onChange={event => { linkRef.current = event.target.value; setLink(event.target.value); }} /><button aria-label="Apply link" type="submit"><Check size={16} /></button><button aria-label="Cancel link" type="button" onClick={() => { linkRef.current = null; setLink(null); editor?.view.focus(); }}><X size={16} /></button>{linkError && <span role="alert">{linkError}</span>}</form>}
  </div>;
}
