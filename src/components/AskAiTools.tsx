import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaptureUpdateAction, convertToExcalidrawElements, exportToBlob, mutateElement, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawElement, ExcalidrawTextElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ChevronDown, ExternalLink, KeyRound, Loader2, Sparkles, X } from 'lucide-react';
import { Modal } from './Modal';
import { deleteSealedAiKey, forgetAiKeyLock, loadSealedAiKey, geminiKeyProblem, openAiKey, rememberAiKeyLock, rememberedAiKeyLock, saveSealedAiKey, sealAiKey, unlockAiKey, WrongPassphraseError, type SealedAiKey } from '../lib/ai-key';
import { askGemini, forgetRoutes, GeminiError, googleAiModeUrl, verifyGeminiKey, type AskRequest } from '../lib/gemini';
import { answerMarkdown, askSelection, documentAnchor, documentContext, isLearnNote, learnPage, noteText, objectContent, threadContext, type LearnData } from '../lib/ask-ai-scene';
import { pageObject } from '../lib/pdf-model';
import type { AskImage } from '../lib/gemini';
import { cleanSelection, LEARN_EDGE, LEARN_EVENT, LEARN_NODE, LEARN_SOURCE_LINE, learnBase, learnEdgeStyle, learnQuestion, placeRightOf, selectionNodeSize, selectionNodeText, type LearnSelection } from '../lib/explain-scene';
import { connectionTarget } from '../lib/connection-targets';
import { attachDiagramEdge, createObjectConnection } from '../lib/diagram-scene';
import { FEYNMAN_INSTRUCTION, readAiInstruction, saveAiInstruction } from '../lib/ai-instruction';
import { jotPlacement } from '../lib/jot-layout';
import { applyRichText } from '../lib/rich-text-scene';
import { clipboardRichDoc, readRichText, richDocText } from '../lib/rich-text';
import './ask-ai.css';

type Dialog = { mode: 'setup' | 'unlock' | 'manage' | 'ask'; message?: string } | { mode: 'error'; message: string; key?: boolean; detail?: string } | null;
/** For Explain/Ask on selected words: the selection, and the node made for it once the key is ready. */
interface Pending { request: AskRequest; anchorId: string | null; parentId?: string; learn?: LearnSelection & { nodeId?: string; added?: string[]; chip?: string } }
export { LEARN_EVENT };

/**
 * Ask AI writes Gemini's answer onto the board as a new note. Each account
 * brings its own free Google AI Studio key, encrypted in the browser with a
 * passphrase only its owner knows, so friends never share anyone's quota.
 * Ask Google (AI Mode in a new tab) needs no key at all.
 */
export function AskAiTools({ api, root, client, owner, onMessage }: { api: ExcalidrawImperativeAPI; root: HTMLElement | null; client: SupabaseClient | null; owner: string; onMessage: (message: string) => void }) {
  const [host, setHost] = useState<Element | null>(null), [dialog, setDialog] = useState<Dialog>(null), [asking, setAsking] = useState(false), [preview, setPreview] = useState('');
  const [sealed, setSealed] = useState<SealedAiKey | null | undefined>(undefined);
  const apiKey = useRef<string | null>(null), pending = useRef<Pending | null>(null), abort = useRef<AbortController | null>(null), busy = useRef(false), mounted = useRef(true);
  const signedIn = !!client && owner !== 'local';
  useLayoutEffect(() => { setHost(root?.closest('.main-content')?.querySelector('.board-header-tools') || null); }, [root]);
  useEffect(() => {
    const request = () => { void start(); };
    const learn = (event: Event) => { const detail = (event as CustomEvent<LearnSelection>).detail; if (!detail?.sourceId || (!detail.object && !cleanSelection(detail.selection || '')) || (detail.kind === 'ask' && !detail.question?.trim())) return; if (busy.current) { onMessage('Gemini is still answering. Ask again when it is done.'); return; } detail.accepted = true; void proceed(() => learnRequest(detail)); };
    root?.addEventListener('note-ask-ai', request); root?.addEventListener(LEARN_EVENT, learn);
    return () => { root?.removeEventListener('note-ask-ai', request); root?.removeEventListener(LEARN_EVENT, learn); };
  }, [root, client, owner]);
  // Leaving the board (or closing it) stops the answer: it has nowhere to land. Switching browser tabs does not.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; if (abort.current || busy.current) { abort.current?.abort(); onMessage('Ask AI stopped because you left the board. Ask again there.'); } }; }, []);

  async function currentSealed() {
    if (!signedIn) return null;
    const value = await loadSealedAiKey(client!); setSealed(value); return value;
  }
  /** The decrypted key, from memory or this device's remembered lock. */
  async function readyKey(): Promise<string | 'setup' | 'unlock'> {
    if (apiKey.current) return apiKey.current;
    const value = await currentSealed();
    if (!value) return 'setup';
    const remembered = await rememberedAiKeyLock(owner);
    if (remembered && remembered.salt === value.salt) {
      try { apiKey.current = await openAiKey(value, remembered.lock); return apiKey.current; } catch { await forgetAiKeyLock(owner); }
    }
    return 'unlock';
  }
  function selectionRequest(question?: string): Pending {
    const state = api.getAppState(), picked = askSelection(api.getSceneElements(), state.selectedElementIds, api.getFiles());
    const texts = question ? [...picked.texts, question] : picked.texts;
    if (picked.skippedImages) onMessage(`${picked.skippedImages} selected image${picked.skippedImages === 1 ? ' was' : 's were'} not sent (only PNG, JPEG, or WebP up to about 4 MB, three at most).`);
    const anchor = picked.anchor && isLearnNote(picked.anchor) ? picked.anchor.id : undefined;
    return { request: { question: texts.at(-1) || '', context: texts.slice(0, -1), images: picked.images, mode: 'ask' }, anchorId: picked.anchor?.id || null, parentId: anchor };
  }
  /**
   * Explain/Ask on selected words: the note (and the thread it belongs to,
   * back to a sent page) is the context, so the words are explained in the
   * sense they have there. With `object`, the whole selected object is what
   * it is about: its words, its picture, or a snapshot of a drawing. Ask is
   * clean (no instruction); the saved instruction is for Explain only.
   */
  async function learnRequest(ask: LearnSelection): Promise<Pending | null> {
    const elements = api.getSceneElements(), target = connectionTarget(elements, ask.sourceId), sourceId = target?.element.id || ask.sourceId;
    const question = ask.question?.trim(), instruction = ask.kind === 'explain' ? readAiInstruction() : undefined;
    const fromDocument = documentContext(elements, target?.element);
    if (!ask.object) {
      const learn = { ...ask, sourceId, selection: cleanSelection(ask.selection), question };
      const context = threadContext(elements, sourceId);
      // The highlight's own words are the selection; the page they are on is the context.
      if (fromDocument) { if (context.at(-1) === learn.selection.slice(0, 1500)) context.pop(); context.unshift(fromDocument); }
      return { request: { question: learnQuestion(learn), context, images: [], instruction, mode: ask.kind, focus: learn.selection }, anchorId: sourceId, parentId: sourceId, learn };
    }
    if (!target) return null;
    const groupId = target.groupId;
    const members = groupId ? elements.filter(element => !element.isDeleted && element.groupIds?.includes(groupId) && !(element.type === 'text' && element.containerId) && !element.customData?.noteRichTextRender) : [target.element];
    const content = objectContent(elements, members, api.getFiles());
    const images = content.snapshot ? await snapshot(members) : content.images;
    if (!content.text && !images.length) { onMessage('This object has no words or picture to send.'); return null; }
    // The object's own words are what it is about, so they are not repeated as context.
    const context = threadContext(elements, sourceId);
    if (!learnPage(target.element) && context.at(-1) === noteText(target.element, elements).slice(0, 1500)) context.pop();
    const page = pageObject(target.element);
    if (fromDocument && !page) context.unshift(fromDocument);
    else if (page) context.unshift(`The person is reading the document “${page.name}”; this is page ${page.page}. Its picture and its words are attached.`);
    const chip = page ? `Page ${page.page} · ${page.name.length > 40 ? `${page.name.slice(0, 39)}…` : page.name}` : content.text ? undefined : content.kind === 'image' ? 'Picture' : 'Drawing';
    const learn = { ...ask, sourceId, selection: content.text, question, chip };
    return { request: { question: learnQuestion(learn), context, images, instruction, mode: ask.kind, focus: content.text, picture: !content.text }, anchorId: sourceId, parentId: sourceId, learn };
  }
  /** A picture of a drawing or wordless shape, for Gemini to look at (white background, at most 1600 px). */
  async function snapshot(members: readonly ExcalidrawElement[]): Promise<AskImage[]> {
    try {
      const blob = await exportToBlob({ elements: members, files: api.getFiles(), mimeType: 'image/png', maxWidthOrHeight: 1600, exportPadding: 16,
        appState: { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false } });
      const data = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = reject; reader.readAsDataURL(blob); });
      const match = /^data:([^;,]+);base64,(.*)$/.exec(data);
      return match ? [{ mimeType: match[1], data: match[2] }] : [];
    } catch { return []; }
  }
  async function start() {
    if (busy.current) return;
    const next = selectionRequest();
    if (!next.request.question.trim()) { pending.current = next; setDialog({ mode: 'ask' }); return; }
    await proceed(next);
  }
  /** One question at a time: busy covers loading the key as well as the answer. */
  async function proceed(next: Pending | (() => Promise<Pending | null>)) {
    if (busy.current) return;
    busy.current = true;
    if (typeof next === 'function') setAsking(true);
    try {
      const ready = typeof next === 'function' ? await next() : next;
      if (ready && mounted.current) await prepare(ready);
    } catch (error) {
      if (mounted.current) setDialog({ mode: 'error', message: error instanceof Error ? error.message : 'Could not prepare the question.' });
    } finally { if (!abort.current) { busy.current = false; if (mounted.current) setAsking(false); } }
  }
  async function prepare(next: Pending) {
    pending.current = next;
    if (!signedIn) { setDialog({ mode: 'error', message: 'Ask AI needs a signed-in Google account so your encrypted key can be saved. You can still use Ask Google.' }); return; }
    let key: Awaited<ReturnType<typeof readyKey>>;
    try { key = await readyKey(); } catch (error) { setDialog({ mode: 'error', message: error instanceof Error ? error.message : 'Could not load your Ask AI key.' }); return; }
    if (!mounted.current) return;
    if (key === 'setup' || key === 'unlock') { setDialog({ mode: key }); return; }
    await run(key, next);
  }
  async function run(key: string, next: Pending) {
    pending.current = next; busy.current = true; setDialog(null); setAsking(true); setPreview('');
    const controller = new AbortController(); abort.current = controller;
    try {
      if (next.learn && !next.learn.nodeId) next.learn.nodeId = addSelectionNode(next.learn) || undefined;
      const answer = await askGemini(key, next.request, { signal: controller.signal, onText: setPreview });
      if (next.learn) placeLearnAnswer(answerMarkdown(answer), next, answer.model || 'gemini'); else placeAnswer(answerMarkdown(answer), next, answer.model || 'gemini');
      pending.current = null;
      if (!answer.searched && next.request.mode !== 'explain') onMessage('Answered without Google Search (its free allowance may be used up), so it may miss recent facts.');
    } catch (error) {
      // No half-made branches: a failed or cancelled Explain/Ask removes the chip it added.
      if (next.learn?.added?.length) { removeElements(next.learn.added); next.learn.nodeId = undefined; next.learn.added = undefined; }
      if ((error as Error)?.name === 'AbortError') return;
      const message = error instanceof Error ? error.message : 'Gemini could not answer.';
      if (error instanceof GeminiError && error.kind === 'key') apiKey.current = null;
      setDialog({ mode: 'error', message, key: error instanceof GeminiError && error.kind === 'key', detail: error instanceof GeminiError ? error.detail : '' });
    } finally { if (abort.current === controller) { abort.current = null; busy.current = false; } setAsking(false); setPreview(''); }
  }
  function placeAnswer(markdown: string, next: Pending, model: string) {
    const state = api.getAppState(), elements = api.getSceneElements();
    const anchor = next.anchorId ? elements.find(element => element.id === next.anchorId) : undefined;
    const fontSize = anchor?.type === 'text' ? anchor.fontSize : state.currentItemFontSize || 20;
    const place = anchor ? jotPlacement({ ...anchor, fontSize, customData: anchor.type === 'text' ? anchor.customData : {} }, anchor.type === 'text' ? 'child' : 'sibling', elements)
      : { x: state.width / 2 / state.zoom.value - state.scrollX - 200, y: state.height / 2 / state.zoom.value - state.scrollY - 40, jot: { level: 0, step: Math.round(fontSize * 1.5) } };
    const doc = clipboardRichDoc(markdown, false), wrap = Math.round(fontSize * 24);
    const color = anchor?.type === 'text' ? readRichText(anchor)?.color || anchor.strokeColor : state.currentItemStrokeColor;
    const [created] = convertToExcalidrawElements([{ type: 'text', text: richDocText(doc), x: place.x, y: place.y, fontSize, fontFamily: anchor?.type === 'text' ? anchor.fontFamily : state.currentItemFontFamily }]);
    const text = { ...created, width: wrap, customData: { noteJot: place.jot, noteAi: learnData(next, model) } } as ExcalidrawTextElement;
    applyRichText(text, doc, color, true, { wrap, width: wrap, fontSize });
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), text], appState: { selectedElementIds: { [text.id]: true }, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    requestAnimationFrame(() => api.scrollToContent(text, { fitToContent: false, animate: true }));
  }
  /** The chip holding the selected words (and the question), to the right of its note, joined by a line. */
  function addSelectionNode(learn: Pending['learn'] & {}): string | null {
    const elements = api.getSceneElements(), source = connectionTarget(elements, learn.sourceId), state = api.getAppState();
    if (!source) return null;
    const label = (source.element.type === 'text' ? source.element : elements.find(item => item.type === 'text' && item.containerId === source.element.id)) as ExcalidrawTextElement | undefined;
    const base = learnBase({ fontSize: label?.fontSize, customData: source.element.customData }), k = base / 20;
    const text = selectionNodeText(learn.selection, learn.kind === 'ask' ? learn.question : undefined, learn.chip);
    const size = selectionNodeSize(text, base), place = placeRightOf(documentAnchor(elements, source.element) || source.geometry, size, elements, LEARN_NODE.gapSource * k, LEARN_NODE.gapStack * k);
    const created = convertToExcalidrawElements([{ type: 'rectangle', ...place, ...size, strokeColor: LEARN_NODE.stroke, backgroundColor: LEARN_NODE.fill, fillStyle: 'solid', strokeWidth: LEARN_NODE.chipStrokeWidth,
      roughness: 0, roundness: LEARN_NODE.roundness, customData: { noteAi: { question: text.slice(0, 500), at: new Date().toISOString(), parentId: source.element.id, role: 'selection', kind: learn.kind, selection: learn.selection, base } satisfies LearnData },
      label: { text, fontSize: base, fontFamily: label?.fontFamily || state.currentItemFontFamily, strokeColor: LEARN_NODE.text, textAlign: 'left', verticalAlign: 'middle' } }]);
    const node = created.find(element => element.type === 'rectangle')!;
    // EVENTUALLY folds the chip into the answer's undo step: one Ctrl+Z removes the whole branch.
    learn.added = [...created, ...link(source.element.id, node.id, created, LEARN_SOURCE_LINE, CaptureUpdateAction.EVENTUALLY)].map(element => element.id);
    requestAnimationFrame(() => api.scrollToContent(node, { fitToContent: false, animate: true }));
    return node.id;
  }
  /** The answer, to the right of its chip (or of the note, if the chip was deleted), joined by a line with an arrowhead. */
  function placeLearnAnswer(markdown: string, next: Pending, model: string) {
    const state = api.getAppState(), elements = api.getSceneElements(), learn = next.learn!;
    const from = connectionTarget(elements, learn.nodeId || '') || connectionTarget(elements, learn.sourceId);
    const source = connectionTarget(elements, learn.sourceId)?.element;
    const label = (source && (source.type === 'text' ? source : elements.find(item => item.type === 'text' && item.containerId === source.id))) as ExcalidrawTextElement | undefined;
    const base = learnBase({ fontSize: label?.fontSize, customData: from?.element.customData }), k = base / 20, fontSize = Math.round(base * LEARN_NODE.answerFontFactor);
    const doc = clipboardRichDoc(markdown, false), wrap = Math.round(fontSize * LEARN_NODE.answerChars);
    const [created] = convertToExcalidrawElements([{ type: 'text', text: richDocText(doc), x: 0, y: 0, fontSize, fontFamily: label?.fontFamily || state.currentItemFontFamily }]);
    const text = { ...created, width: wrap, customData: { noteAi: { provider: 'gemini', model, question: next.request.question.slice(0, 500), at: new Date().toISOString(), role: 'answer', kind: learn.kind, base, ...(from ? { parentId: from.element.id } : {}) } satisfies LearnData } } as ExcalidrawTextElement;
    const ink = (label && readRichText(label)?.color) || (label && label.strokeColor !== 'transparent' ? label.strokeColor : '') || state.currentItemStrokeColor;
    applyRichText(text, doc, ink, true, { wrap, width: wrap, fontSize });
    const place = from ? placeRightOf(documentAnchor(elements, from.element) || from.geometry, { width: text.width, height: text.height }, elements, LEARN_NODE.gapAnswer * k, LEARN_NODE.gapStack * k) : { x: state.width / 2 / state.zoom.value - state.scrollX - 200, y: state.height / 2 / state.zoom.value - state.scrollY - 40 };
    mutateElement(text, place, false);
    if (from) link(from.element.id, text.id, [text], LEARN_EDGE, CaptureUpdateAction.IMMEDIATELY); else api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), text], captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    api.updateScene({ appState: { selectedElementIds: { [text.id]: true }, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.NEVER });
    requestAnimationFrame(() => api.scrollToContent(text, { fitToContent: false, animate: true }));
  }
  /** Add new elements with a line from `fromId` to `toId` that follows both when they move; returns the line. */
  function link(fromId: string, toId: string, added: readonly ExcalidrawElement[], settings: typeof LEARN_EDGE, capture: typeof CaptureUpdateAction[keyof typeof CaptureUpdateAction]): ExcalidrawElement[] {
    // Work on a copy of the scene: changing live elements in place would bypass undo.
    const all = [...structuredClone(api.getSceneElementsIncludingDeleted()) as ExcalidrawElement[], ...added];
    let edges: ExcalidrawElement[] = [];
    try { edges = createObjectConnection(all.filter(element => !element.isDeleted), fromId, toId, settings, learnEdgeStyle()); attachDiagramEdge(all, edges); } catch { /* the nodes still land; only the line is missing */ }
    api.updateScene({ elements: [...all, ...edges], captureUpdate: capture });
    return edges;
  }
  /** Remove elements this feature added (a branch whose answer never came). */
  function removeElements(ids: readonly string[]) {
    const gone = new Set(ids);
    const elements = api.getSceneElementsIncludingDeleted().map(element => gone.has(element.id) ? newElementWith(element, { isDeleted: true })
      : element.boundElements?.some(bound => gone.has(bound.id)) ? newElementWith(element, { boundElements: element.boundElements.filter(bound => !gone.has(bound.id)) }) : element);
    // NEVER: the chip's creation was not its own undo step either, so nothing to undo here.
    api.updateScene({ elements, captureUpdate: CaptureUpdateAction.NEVER });
  }
  function askGoogle(question = pending.current?.request.question || '') {
    window.open(googleAiModeUrl(question || 'Ask anything'), '_blank', 'noopener');
    setDialog(null);
  }
  async function keyReady(key: string, lock: CryptoKey, value: SealedAiKey, remember: boolean) {
    apiKey.current = key; setSealed(value); forgetRoutes();
    if (remember) await rememberAiKeyLock(owner, { lock, salt: value.salt }); else await forgetAiKeyLock(owner);
    const next = pending.current;
    if (next?.request.question.trim()) await run(key, next); else setDialog(null);
  }

  return <>
    {host && createPortal(<div className="board-header-split ask-ai-tools">
      <button className="board-header-button" aria-label="Ask AI about the selected note" title="Ask AI about the selected note or picture (Alt+Enter while typing)" disabled={asking} onClick={() => { void start(); }}>
        {asking ? <Loader2 className="spinning" size={16} /> : <Sparkles size={16} />}<span>Ask AI</span></button>
      <button className="board-header-button board-header-chevron" aria-label="Ask AI settings" aria-haspopup="dialog" onClick={() => { pending.current = null; void currentSealed().catch(() => undefined); setDialog({ mode: 'manage' }); }}><ChevronDown size={14} /></button>
    </div>, host)}
    {asking && <div className={`ask-ai-status${preview ? ' streaming' : ''}`}><span className="ask-ai-status-line"><Loader2 className="spinning" size={15} aria-hidden /> <span role="status">{preview ? 'Gemini is writing…' : 'Asking Gemini…'}</span> <button type="button" aria-label="Cancel" title="Cancel" onClick={() => abort.current?.abort()}><X size={14} /></button></span>{preview && <p className="ask-ai-preview"><span>{previewText(preview)}</span></p>}</div>}
    {dialog && createPortal(<AskAiDialog dialog={dialog} sealed={sealed} signedIn={signedIn} pending={pending.current}
      onClose={() => setDialog(null)} onGoogle={askGoogle} onMode={mode => setDialog({ mode })}
      onAsk={question => { const next = selectionRequest(question); if (next.request.question.trim()) void proceed(next); }}
      onSetup={async (key, passphrase, remember) => { if (await verifyGeminiKey(key) === 'offline') onMessage('Could not reach Google to check the key; saved it anyway.'); const { sealed: value, lock } = await sealAiKey(key, passphrase); await saveSealedAiKey(client!, value); await keyReady(key.trim(), lock, value, remember); }}
      onUnlock={async (passphrase, remember) => { const value = sealed || await currentSealed(); if (!value) { setDialog({ mode: 'setup' }); return; } const { apiKey: key, lock } = await unlockAiKey(value, passphrase); await keyReady(key, lock, value, remember); }}
      onForget={async () => { apiKey.current = null; await forgetAiKeyLock(owner); setDialog(null); onMessage('Ask AI is locked on this device. Your encrypted key stays in your account.'); }}
      onRemove={async () => { apiKey.current = null; forgetRoutes(); await forgetAiKeyLock(owner); await deleteSealedAiKey(client!, owner); setSealed(null); setDialog(null); onMessage('Your Gemini key was removed from your account.'); }} />, document.body)}
  </>;
}

/** The live preview is plain text: drop the term brackets and the bold and heading marks the note will draw. */
const previewText = (text: string) => text.replace(/\[\[|\]\]/g, '').replace(/\*\*|__/g, '').replace(/^#{1,6}\s+/gm, '');

function learnData(next: Pending, model: string): LearnData {
  return { provider: 'gemini', model, question: next.request.question.slice(0, 500), at: new Date().toISOString(), ...(next.parentId ? { parentId: next.parentId } : {}) };
}

/** The standing instruction, sent with every Explain (Ask is clean); kept in this browser. */
function InstructionField() {
  // Saved as you type, so closing the dialog can never lose it.
  const [text, setText] = useState(readAiInstruction);
  const change = (value: string) => { setText(value); saveAiInstruction(value); };
  return <div className="ask-ai-instruction">
    <label>Explain instruction<small>Sent with every Explain and followed over the app's own defaults. Ask sends no instruction: only what you selected and your prompt. Saved in this browser as you type.</small>
      <textarea rows={4} maxLength={2000} value={text} placeholder="For example: explain like Feynman, plain words, one everyday picture." onChange={event => change(event.target.value)} /></label>
    {!text.trim() && <div className="dialog-actions"><button type="button" className="secondary-button" onClick={() => change(FEYNMAN_INSTRUCTION)}>Use Feynman style</button></div>}
  </div>;
}

function AskAiDialog({ dialog, sealed, signedIn, pending, onClose, onGoogle, onMode, onAsk, onSetup, onUnlock, onForget, onRemove }: {
  dialog: NonNullable<Dialog>; sealed: SealedAiKey | null | undefined; signedIn: boolean; pending: Pending | null;
  onClose: () => void; onGoogle: (question?: string) => void; onMode: (mode: 'setup' | 'unlock' | 'manage') => void; onAsk: (question: string) => void;
  onSetup: (key: string, passphrase: string, remember: boolean) => Promise<void>; onUnlock: (passphrase: string, remember: boolean) => Promise<void>;
  onForget: () => Promise<void>; onRemove: () => Promise<void>;
}) {
  const [key, setKey] = useState(''), [passphrase, setPassphrase] = useState(''), [confirm, setConfirm] = useState(''), [remember, setRemember] = useState(true);
  const [question, setQuestion] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [removing, setRemoving] = useState(false);
  const act = async (work: () => Promise<void>) => {
    setBusy(true); setError('');
    try { await work(); } catch (failure) { setError(failure instanceof WrongPassphraseError ? failure.message : failure instanceof Error ? failure.message : 'Something went wrong.'); } finally { setBusy(false); }
  };
  const google = <button type="button" className="secondary-button" onClick={() => onGoogle(dialog.mode === 'ask' ? question : undefined)}>Ask Google instead <ExternalLink size={14} /></button>;
  const rememberBox = <label className="toggle-row ask-ai-remember"><span><strong>Remember on this device</strong><small>Skip the passphrase next time on this browser. Turn off on shared computers.</small></span><input type="checkbox" checked={remember} onChange={event => setRemember(event.target.checked)} /></label>;
  if (dialog.mode === 'error') return <Modal title="Ask AI" onClose={onClose}>
    <p className="dialog-description" role="alert">{dialog.message}</p>
    {dialog.detail && <details className="ask-ai-detail"><summary>Google’s message</summary><p>{dialog.detail}</p></details>}
    <div className="dialog-actions">{dialog.key && <button type="button" className="secondary-button" onClick={() => onMode('setup')}><KeyRound size={14} /> Update key</button>}{google}<button type="button" className="primary-button" onClick={onClose}>Close</button></div>
  </Modal>;
  if (dialog.mode === 'ask') return <Modal title="Ask AI" onClose={onClose} initialFocus="textarea">
    <form onSubmit={event => { event.preventDefault(); if (question.trim()) onAsk(question.trim()); }}>
      <label>Your question<textarea rows={3} value={question} placeholder="What is this? How does it work?" onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); if (question.trim()) onAsk(question.trim()); } }} /></label>
      {!!pending?.request.images.length && <p className="small-note">{pending.request.images.length} selected picture{pending.request.images.length === 1 ? '' : 's'} will be sent with your question.</p>}
      <p className="small-note">The answer appears as a new note on the board. Tip: select a note and choose Ask AI, or press Alt+Enter while typing a note.</p>
      <div className="dialog-actions">{google}<button type="submit" className="primary-button" disabled={!question.trim()}><Sparkles size={14} /> Ask Gemini</button></div>
    </form>
  </Modal>;
  if (dialog.mode === 'unlock') return <Modal title="Unlock Ask AI" onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); void act(() => onUnlock(passphrase, remember)); }}>
      <p className="dialog-description">Enter the passphrase you chose for your Gemini key. It unlocks the key in this browser only; Note never stores or sends it.</p>
      <label>Passphrase<input type="password" autoComplete="current-password" value={passphrase} onChange={event => setPassphrase(event.target.value)} /></label>
      {rememberBox}
      {error && <p className="form-error" role="alert">{error}</p>}
      <p className="small-note">Forgot it? <button type="button" className="text-button" onClick={() => onMode('setup')}>Save a new key</button> — create one in Google AI Studio and pick a new passphrase.</p>
      <div className="dialog-actions">{google}<button type="submit" className="primary-button" disabled={busy || !passphrase}>{busy ? 'Unlocking…' : 'Unlock'}</button></div>
    </form>
  </Modal>;
  if (dialog.mode === 'manage') return <Modal title="Ask AI" onClose={onClose}>
    <p className="dialog-description">Ask AI sends the selected notes and pictures to Google Gemini with your own free API key, then adds the answer to the board as a new note. Each person uses their own key and daily allowance.</p>
    <div className="settings-account"><span><KeyRound size={18} /><strong>{!signedIn ? 'Sign in with Google to save a key' : sealed === undefined ? 'Checking your key…' : sealed ? 'Encrypted key saved in your account' : 'No key saved yet'}</strong></span>
      {signedIn && <button type="button" className="secondary-button" onClick={() => onMode('setup')}>{sealed ? 'Replace key' : 'Add key'}</button>}</div>
    <p className="small-note">Your key is encrypted in this browser with your passphrase before it is saved. The database, the server, and the app owner only see scrambled text. Free-tier questions may be used by Google to improve its products, so avoid sending private information. Delete or replace a key anytime in <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Google AI Studio</a>.</p>
    <InstructionField />
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions">
      {sealed && <button type="button" className="secondary-button" disabled={busy} onClick={() => void act(onForget)}>Lock on this device</button>}
      {sealed && <button type="button" className="secondary-button" disabled={busy} onClick={() => { if (removing) void act(onRemove); else setRemoving(true); }}>{removing ? 'Confirm remove' : 'Remove key'}</button>}
      <button type="button" className="primary-button" onClick={onClose}>Done</button>
    </div>
  </Modal>;
  const mismatch = !!confirm && confirm !== passphrase, keyProblem = geminiKeyProblem(key), keyValid = !!key.trim() && !keyProblem;
  return <Modal title="Set up Ask AI" onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); if (keyValid && passphrase.length >= 8 && !mismatch) void act(() => onSetup(key, passphrase, remember)); }}>
      <ol className="ask-ai-steps">
        <li>Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Google AI Studio → API keys</a> and sign in with your Google account.</li>
        <li>Choose <strong>Create API key</strong>, then copy it with the copy button on the key card (not the Project ID). The free tier needs no card; skip any billing setup, because a project with billing (shown as Tier 1) is charged per question.</li>
        <li>Paste it below and choose a passphrase. You will need the passphrase once on each device.</li>
      </ol>
      <label>Gemini API key<input type="password" autoComplete="off" spellCheck={false} value={key} placeholder="Paste your key" onChange={event => setKey(event.target.value)} /></label>
      {keyProblem && <p className="form-error">{keyProblem}</p>}
      <label>Passphrase (at least 8 characters)<input type="password" autoComplete="new-password" value={passphrase} onChange={event => setPassphrase(event.target.value)} /></label>
      <label>Repeat passphrase<input type="password" autoComplete="new-password" value={confirm} onChange={event => setConfirm(event.target.value)} /></label>
      {mismatch && <p className="form-error">The passphrases do not match.</p>}
      {rememberBox}
      <p className="small-note">Your key is encrypted on this device before it is saved; nobody, including the app owner, can read it without your passphrase. There is no passphrase recovery: if you forget it, just save a new key.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">{google}<button type="submit" className="primary-button" disabled={busy || !keyValid || passphrase.length < 8 || confirm !== passphrase}>{busy ? 'Checking key…' : pending?.request.question.trim() ? 'Save and ask' : 'Save key'}</button></div>
    </form>
  </Modal>;
}
