import { useLayoutEffect, useRef, useState } from 'react';
import { EditorContent, useEditor } from '@tiptap/react';
import { AllSelection, Selection } from '@tiptap/pm/state';
import { Bold, Italic, Underline, Strikethrough, List, ListOrdered, ListTodo, Code, Quote, Link2, Undo2, Redo2, Eraser, Table2 } from 'lucide-react';
import { Modal } from './Modal';
import { cleanRichDoc, clipboardRichDoc, hasRichFormatting, markdownRichDoc, richDocMarkdown, richTextExtensions, RICH_FONTS, safeTextLink, type RichDoc } from '../lib/rich-text';
import { diagramShortcutRelation, type DiagramShortcutRelation } from '../lib/diagram-shortcuts';
import './rich-text.css';

export function RichTextEditor({ doc, fontSize, color, textAlign, diagram, selectAll, onApply, onDraft }: {
  doc: RichDoc; fontSize: number; color: string; textAlign: 'left' | 'center' | 'right'; diagram: boolean; selectAll: boolean;
  onApply: (doc: RichDoc, relation?: DiagramShortcutRelation) => void;
  onDraft: (doc: RichDoc) => void;
}) {
  const [source, setSource] = useState<string | null>(null), sourceRef = useRef<string | null>(null);
  const [link, setLink] = useState<string | null>(null), [linkError, setLinkError] = useState('');
  const [notice, setNotice] = useState('');
  const [revision, refresh] = useState(0); void revision;
  const draft = useRef(doc), pasteMode = useRef({ raw: false, at: 0 });
  const editorRef = useRef<ReturnType<typeof useEditor>>(null);
  function currentDoc() { return sourceRef.current === null ? cleanRichDoc(draft.current) : markdownRichDoc(sourceRef.current); }
  function finish(relation?: DiagramShortcutRelation) { onApply(currentDoc(), relation); }
  const editor = useEditor({
    extensions: richTextExtensions(), content: doc, immediatelyRender: true,
    onUpdate: ({ editor: updated }) => { draft.current = cleanRichDoc(updated.getJSON()); onDraft(draft.current); },
    onTransaction: () => refresh(value => value + 1),
    editorProps: {
      attributes: { class: 'note-rich-content', role: 'textbox', 'aria-label': 'Text content', 'aria-multiline': 'true', spellcheck: 'true' },
      handleKeyDown: (_view, event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') pasteMode.current = { raw: event.shiftKey, at: Date.now() };
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault(); setLink(editorRef.current?.getAttributes('link').href || 'https://'); setLinkError(''); return true;
        }
        const relation = diagram && diagramShortcutRelation(event);
        if (relation || (!event.isComposing && !event.repeat && event.key === 'Enter' && (event.ctrlKey || event.metaKey))) {
          event.preventDefault(); event.stopPropagation(); finish(relation || undefined); return true;
        }
        return false;
      },
      handlePaste: (_view, event) => {
        const raw = pasteMode.current.raw && Date.now() - pasteMode.current.at < 2000; pasteMode.current = { raw: false, at: 0 };
        const text = event.clipboardData?.getData('text/plain'); if (!text) return false;
        const parsed = clipboardRichDoc(text, raw);
        // Keep formatting from a copied web page, but interpret Markdown text.
        if (!raw && !hasRichFormatting(parsed) && event.clipboardData?.getData('text/html')) return false;
        event.preventDefault();
        const current = editorRef.current;
        if (raw) current?.chain().unsetAllMarks().insertContent(parsed).run();
        else current?.commands.insertContent(parsed);
        return true;
      },
    },
  });
  editorRef.current = editor;
  useLayoutEffect(() => {
    if (!editor || editor.isDestroyed) return;
    // Focus before creating the selection transaction: touch browsers can
    // flush pending DOM input on focus, changing the document synchronously.
    editor.view.focus();
    const state = editor.state;
    editor.view.dispatch(state.tr.setSelection(selectAll ? new AllSelection(state.doc) : Selection.atEnd(state.doc)));
  }, [editor]);
  function toggleSource() {
    if (sourceRef.current === null) {
      const value = richDocMarkdown(draft.current); sourceRef.current = value; setSource(value);
    } else {
      const parsed = markdownRichDoc(sourceRef.current); draft.current = parsed; editor?.commands.setContent(parsed);
      sourceRef.current = null; setSource(null); onDraft(parsed); editor?.commands.focus('end');
    }
  }
  const button = (label: string, icon: React.ReactNode, active: boolean, action: () => void, disabled = false) => <button type="button" aria-label={label} title={label} aria-pressed={active} disabled={disabled || source !== null} onMouseDown={event => event.preventDefault()} onClick={action}>{icon}</button>;
  return <div className="rich-text-editor-layer" onKeyDownCapture={event => {
    const target = event.target as HTMLElement;
    if (!target.closest('[contenteditable="true"], .rich-markdown-source')) return;
    const relation = diagram && diagramShortcutRelation(event.nativeEvent);
    if (relation) { event.preventDefault(); event.stopPropagation(); finish(relation); }
  }}><Modal title={diagram ? 'Diagram text' : 'Text'} wide initialFocus='[contenteditable="true"]' onClose={() => finish()}>
    <div className="rich-text-tabs"><div role="group" aria-label="Text editing mode"><button aria-pressed={source === null} onClick={() => { if (source !== null) toggleSource(); }}>Visual</button><button aria-pressed={source !== null} onClick={() => { if (source === null) toggleSource(); }}>Markdown</button></div><button className="text-button" onClick={() => { void (navigator.clipboard?.writeText(richDocMarkdown(currentDoc())) || Promise.reject()).then(() => setNotice('Markdown copied.')).catch(() => setNotice('Copy is unavailable. Select the text in the Markdown tab to copy it.')); }}>Copy Markdown</button></div>
    {editor && <div className="rich-text-toolbar" role="toolbar" aria-label="Text formatting">
      <label className="rich-style"><span className="sr-only">Text style</span><select aria-label="Text style" disabled={source !== null} value={editor.isActive('heading') ? String(editor.getAttributes('heading').level) : editor.isActive('codeBlock') ? 'code' : 'paragraph'} onChange={event => {
        const value = event.target.value;
        if (value === 'paragraph') editor.chain().focus().setParagraph().run();
        else if (value === 'code') editor.chain().focus().setCodeBlock().run();
        else editor.chain().focus().setHeading({ level: Number(value) as 1 | 2 | 3 | 4 | 5 | 6 }).run();
      }}><option value="paragraph">Normal text</option>{[1, 2, 3, 4, 5, 6].map(level => <option key={level} value={level}>Heading {level}</option>)}<option value="code">Code block</option></select></label>
      <select aria-label="Font family" disabled={source !== null} value={editor.getAttributes('textStyle').fontFamily || 'Arial'} onChange={event => editor.chain().focus().setFontFamily(event.target.value).run()}>{RICH_FONTS.map(family => <option key={family} value={family}>{family === 'Arial' ? 'Sans serif' : family === 'Georgia' ? 'Serif' : 'Monospace'}</option>)}</select>
      <select aria-label="Font size" disabled={source !== null} value={editor.getAttributes('textStyle').fontSize || ''} onChange={event => { if (event.target.value) editor.chain().focus().setFontSize(event.target.value).run(); else editor.chain().focus().unsetFontSize().run(); }}><option value="">Default ({fontSize})</option>{[12, 14, 16, 18, 20, 24, 28, 32, 40, 48, 64, 96].map(size => <option key={size} value={`${size}px`}>{size}</option>)}</select>
      {button('Bold (Ctrl+B)', <Bold size={17} />, editor.isActive('bold'), () => editor.chain().focus().toggleBold().run())}
      {button('Italic (Ctrl+I)', <Italic size={17} />, editor.isActive('italic'), () => editor.chain().focus().toggleItalic().run())}
      {button('Underline (Ctrl+U)', <Underline size={17} />, editor.isActive('underline'), () => editor.chain().focus().toggleUnderline().run())}
      {button('Strikethrough', <Strikethrough size={17} />, editor.isActive('strike'), () => editor.chain().focus().toggleStrike().run())}
      <label className="rich-color" title="Text color"><span>A</span><input type="color" aria-label="Text color" disabled={source !== null} value={/^#[\da-f]{6}$/i.test(editor.getAttributes('textStyle').color) ? editor.getAttributes('textStyle').color : color} onChange={event => editor.chain().focus().setColor(event.target.value).run()} /></label>
      <label className="rich-color" title="Highlight color"><span>▰</span><input type="color" aria-label="Highlight color" disabled={source !== null} defaultValue="#fef08a" onChange={event => editor.chain().focus().setBackgroundColor(event.target.value).run()} /></label>
      {button('Bulleted list', <List size={17} />, editor.isActive('bulletList'), () => editor.chain().focus().toggleBulletList().run())}
      {button('Numbered list', <ListOrdered size={17} />, editor.isActive('orderedList'), () => editor.chain().focus().toggleOrderedList().run())}
      {button('Checklist', <ListTodo size={17} />, editor.isActive('taskList'), () => editor.chain().focus().toggleTaskList().run())}
      {button('Quote', <Quote size={17} />, editor.isActive('blockquote'), () => editor.chain().focus().toggleBlockquote().run())}
      {button('Inline code', <Code size={17} />, editor.isActive('code'), () => editor.chain().focus().toggleCode().run())}
      {button('Add or edit link', <Link2 size={17} />, editor.isActive('link'), () => { setLink(editor.getAttributes('link').href || 'https://'); setLinkError(''); })}
      {button('Insert table', <Table2 size={17} />, editor.isActive('table'), () => editor.chain().focus().insertTable({ rows: 3, cols: 2, withHeaderRow: true }).run())}
      {button('Clear formatting', <Eraser size={17} />, false, () => editor.chain().focus().unsetAllMarks().clearNodes().run())}
      {button('Undo text edit', <Undo2 size={17} />, false, () => editor.chain().focus().undo().run(), !editor.can().undo())}
      {button('Redo text edit', <Redo2 size={17} />, false, () => editor.chain().focus().redo().run(), !editor.can().redo())}
    </div>}
    {link !== null && <form className="rich-link-form" onSubmit={event => { event.preventDefault(); const href = safeTextLink(link); if (!href && link) { setLinkError('Use an https://, http://, mailto:, or tel: link.'); return; } if (href) editor?.chain().focus().extendMarkRange('link').setLink({ href }).run(); else editor?.chain().focus().extendMarkRange('link').unsetLink().run(); setLink(null); }}><input aria-label="Link address" value={link} onChange={event => setLink(event.target.value)} autoFocus /><button className="secondary-button" type="submit">Apply link</button><button type="button" onClick={() => setLink(null)}>Cancel</button>{linkError && <p role="alert">{linkError}</p>}</form>}
    <div className="rich-text-surface" style={{ fontSize, color, textAlign }} hidden={source !== null}><EditorContent editor={editor} /></div>
    {source !== null && <textarea className="rich-markdown-source" aria-label="Markdown source" value={source} autoFocus spellCheck={false} onChange={event => { sourceRef.current = event.target.value; setSource(event.target.value); const parsed = markdownRichDoc(event.target.value); draft.current = parsed; onDraft(parsed); }} />}
    <p className="rich-text-hint">Ctrl+V formats Markdown · Ctrl+Shift+V pastes raw text · Ctrl+Enter saves.{diagram && ' Tab: child · Shift+Tab: sibling.'} Use Cmd on Mac.</p>
    {notice && <p className="small-note" role="status">{notice}</p>}
    <div className="dialog-actions">{diagram && <><button className="secondary-button" onClick={() => finish('sibling')}>Save + sibling</button><button className="secondary-button" onClick={() => finish('child')}>Save + child</button></>}<button className="primary-button" onClick={() => finish()}>Done</button></div>
  </Modal></div>;
}
