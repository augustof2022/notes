import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CaptureUpdateAction, convertToExcalidrawElements } from '@excalidraw/excalidraw';
import type { ExcalidrawTextElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ChevronDown, ExternalLink, KeyRound, Loader2, Sparkles, X } from 'lucide-react';
import { Modal } from './Modal';
import { deleteSealedAiKey, forgetAiKeyLock, loadSealedAiKey, looksLikeGeminiKey, openAiKey, rememberAiKeyLock, rememberedAiKeyLock, saveSealedAiKey, sealAiKey, unlockAiKey, WrongPassphraseError, type SealedAiKey } from '../lib/ai-key';
import { askGemini, GEMINI_MODEL, GeminiError, googleAiModeUrl, type AskRequest } from '../lib/gemini';
import { answerMarkdown, askSelection } from '../lib/ask-ai-scene';
import { jotPlacement } from '../lib/jot-layout';
import { applyRichText } from '../lib/rich-text-scene';
import { clipboardRichDoc, readRichText, richDocText } from '../lib/rich-text';
import './ask-ai.css';

type Dialog = { mode: 'setup' | 'unlock' | 'manage' | 'ask'; message?: string } | { mode: 'error'; message: string; key?: boolean } | null;
interface Pending { request: AskRequest; anchorId: string | null }

/**
 * Ask AI writes Gemini's answer onto the board as a new note. Each account
 * brings its own free Google AI Studio key, encrypted in the browser with a
 * passphrase only its owner knows, so friends never share anyone's quota.
 * Ask Google (AI Mode in a new tab) needs no key at all.
 */
export function AskAiTools({ api, root, client, owner, onMessage }: { api: ExcalidrawImperativeAPI; root: HTMLElement | null; client: SupabaseClient | null; owner: string; onMessage: (message: string) => void }) {
  const [host, setHost] = useState<Element | null>(null), [dialog, setDialog] = useState<Dialog>(null), [asking, setAsking] = useState(false);
  const [sealed, setSealed] = useState<SealedAiKey | null | undefined>(undefined);
  const apiKey = useRef<string | null>(null), pending = useRef<Pending | null>(null), abort = useRef<AbortController | null>(null);
  const signedIn = !!client && owner !== 'local';
  useLayoutEffect(() => { setHost(root?.querySelector('[data-toolbar-slot="actions-ask-ai"]') || null); }, [root]);
  useEffect(() => {
    const request = () => { void start(); };
    root?.addEventListener('note-ask-ai', request);
    return () => root?.removeEventListener('note-ask-ai', request);
  }, [root, client, owner]);
  useEffect(() => () => abort.current?.abort(), []);

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
    return { request: { question: texts.at(-1) || '', context: texts.slice(0, -1), images: picked.images }, anchorId: picked.anchor?.id || null };
  }
  async function start() {
    if (asking) return;
    const next = selectionRequest();
    if (!next.request.question.trim()) { pending.current = next; setDialog({ mode: 'ask' }); return; }
    await proceed(next);
  }
  async function proceed(next: Pending) {
    pending.current = next;
    if (!signedIn) { setDialog({ mode: 'error', message: 'Ask AI needs a signed-in Google account so your encrypted key can be saved. You can still use Ask Google.' }); return; }
    let key: Awaited<ReturnType<typeof readyKey>>;
    try { key = await readyKey(); } catch (error) { setDialog({ mode: 'error', message: error instanceof Error ? error.message : 'Could not load your Ask AI key.' }); return; }
    if (key === 'setup' || key === 'unlock') { setDialog({ mode: key }); return; }
    await run(key, next);
  }
  async function run(key: string, next: Pending) {
    pending.current = next; setDialog(null); setAsking(true);
    const controller = new AbortController(); abort.current = controller;
    try {
      const answer = await askGemini(key, next.request, { signal: controller.signal });
      placeAnswer(answerMarkdown(answer), next);
      pending.current = null;
      if (!answer.searched) onMessage('Answered without Google Search (its free allowance may be used up), so it may miss recent facts.');
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') return;
      const message = error instanceof Error ? error.message : 'Gemini could not answer.';
      if (error instanceof GeminiError && error.kind === 'key') apiKey.current = null;
      setDialog({ mode: 'error', message, key: error instanceof GeminiError && error.kind === 'key' });
    } finally { if (abort.current === controller) abort.current = null; setAsking(false); }
  }
  function placeAnswer(markdown: string, next: Pending) {
    const state = api.getAppState(), elements = api.getSceneElements();
    const anchor = next.anchorId ? elements.find(element => element.id === next.anchorId) : undefined;
    const fontSize = anchor?.type === 'text' ? anchor.fontSize : state.currentItemFontSize || 20;
    const place = anchor ? jotPlacement({ ...anchor, fontSize, customData: anchor.type === 'text' ? anchor.customData : {} }, anchor.type === 'text' ? 'child' : 'sibling', elements)
      : { x: state.width / 2 / state.zoom.value - state.scrollX - 200, y: state.height / 2 / state.zoom.value - state.scrollY - 40, jot: { level: 0, step: Math.round(fontSize * 1.5) } };
    const doc = clipboardRichDoc(markdown, false), wrap = Math.round(fontSize * 24);
    const color = anchor?.type === 'text' ? readRichText(anchor)?.color || anchor.strokeColor : state.currentItemStrokeColor;
    const [created] = convertToExcalidrawElements([{ type: 'text', text: richDocText(doc), x: place.x, y: place.y, fontSize, fontFamily: anchor?.type === 'text' ? anchor.fontFamily : state.currentItemFontFamily }]);
    const text = { ...created, width: wrap, customData: { noteJot: place.jot, noteAi: { provider: 'gemini', model: GEMINI_MODEL, question: next.request.question.slice(0, 500), at: new Date().toISOString() } } } as ExcalidrawTextElement;
    applyRichText(text, doc, color, true, { wrap, width: wrap, fontSize });
    api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), text], appState: { selectedElementIds: { [text.id]: true }, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    requestAnimationFrame(() => api.scrollToContent(text, { fitToContent: false, animate: true }));
  }
  function askGoogle(question = pending.current?.request.question || '') {
    window.open(googleAiModeUrl(question || 'Ask anything'), '_blank', 'noopener');
    setDialog(null);
  }
  async function keyReady(key: string, lock: CryptoKey, value: SealedAiKey, remember: boolean) {
    apiKey.current = key; setSealed(value);
    if (remember) await rememberAiKeyLock(owner, { lock, salt: value.salt }); else await forgetAiKeyLock(owner);
    const next = pending.current;
    if (next?.request.question.trim()) await run(key, next); else setDialog(null);
  }

  return <>
    {host && createPortal(<div className="ink-tools ask-ai-tools">
      <button className="ink-eraser-main" aria-label="Ask AI about the selected note" title="Ask AI about the selected note or picture (Alt+Enter while typing)" disabled={asking} onClick={() => { void start(); }}>
        {asking ? <Loader2 className="spinning" size={16} /> : <Sparkles size={16} />}<span>Ask AI</span></button>
      <button className="ink-settings-trigger" aria-label="Ask AI settings" aria-haspopup="dialog" onClick={() => { pending.current = null; void currentSealed().catch(() => undefined); setDialog({ mode: 'manage' }); }}><ChevronDown size={14} /></button>
    </div>, host)}
    {asking && <div className="ask-ai-status" role="status"><Loader2 className="spinning" size={15} /> Asking Gemini… <button type="button" aria-label="Cancel" onClick={() => abort.current?.abort()}><X size={14} /></button></div>}
    {dialog && createPortal(<AskAiDialog dialog={dialog} sealed={sealed} signedIn={signedIn} pending={pending.current}
      onClose={() => setDialog(null)} onGoogle={askGoogle} onMode={mode => setDialog({ mode })}
      onAsk={question => { const next = selectionRequest(question); if (next.request.question.trim()) void proceed(next); }}
      onSetup={async (key, passphrase, remember) => { const { sealed: value, lock } = await sealAiKey(key, passphrase); await saveSealedAiKey(client!, value); await keyReady(key.trim(), lock, value, remember); }}
      onUnlock={async (passphrase, remember) => { const value = sealed || await currentSealed(); if (!value) { setDialog({ mode: 'setup' }); return; } const { apiKey: key, lock } = await unlockAiKey(value, passphrase); await keyReady(key, lock, value, remember); }}
      onForget={async () => { apiKey.current = null; await forgetAiKeyLock(owner); setDialog(null); onMessage('Ask AI is locked on this device. Your encrypted key stays in your account.'); }}
      onRemove={async () => { apiKey.current = null; await forgetAiKeyLock(owner); await deleteSealedAiKey(client!, owner); setSealed(null); setDialog(null); onMessage('Your Gemini key was removed from your account.'); }} />, document.body)}
  </>;
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
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="dialog-actions">
      {sealed && <button type="button" className="secondary-button" disabled={busy} onClick={() => void act(onForget)}>Lock on this device</button>}
      {sealed && <button type="button" className="secondary-button" disabled={busy} onClick={() => { if (removing) void act(onRemove); else setRemoving(true); }}>{removing ? 'Confirm remove' : 'Remove key'}</button>}
      <button type="button" className="primary-button" onClick={onClose}>Done</button>
    </div>
  </Modal>;
  const mismatch = !!confirm && confirm !== passphrase, keyValid = looksLikeGeminiKey(key);
  return <Modal title="Set up Ask AI" onClose={onClose}>
    <form onSubmit={event => { event.preventDefault(); if (keyValid && passphrase.length >= 8 && !mismatch) void act(() => onSetup(key, passphrase, remember)); }}>
      <ol className="ask-ai-steps">
        <li>Open <a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">Google AI Studio → API keys</a> and sign in with your Google account.</li>
        <li>Choose <strong>Create API key</strong> and copy it. The free tier needs no card.</li>
        <li>Paste it below and choose a passphrase. You will need the passphrase once on each device.</li>
      </ol>
      <label>Gemini API key<input type="password" autoComplete="off" spellCheck={false} value={key} placeholder="Paste your key" onChange={event => setKey(event.target.value)} /></label>
      {key && !keyValid && <p className="form-error">That does not look like a Gemini API key. Copy the whole key from AI Studio.</p>}
      <label>Passphrase (at least 8 characters)<input type="password" autoComplete="new-password" value={passphrase} onChange={event => setPassphrase(event.target.value)} /></label>
      <label>Repeat passphrase<input type="password" autoComplete="new-password" value={confirm} onChange={event => setConfirm(event.target.value)} /></label>
      {mismatch && <p className="form-error">The passphrases do not match.</p>}
      {rememberBox}
      <p className="small-note">Your key is encrypted on this device before it is saved; nobody, including the app owner, can read it without your passphrase. There is no passphrase recovery: if you forget it, just save a new key.</p>
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="dialog-actions">{google}<button type="submit" className="primary-button" disabled={busy || !keyValid || passphrase.length < 8 || confirm !== passphrase}>{busy ? 'Encrypting…' : pending?.request.question.trim() ? 'Save and ask' : 'Save key'}</button></div>
    </form>
  </Modal>;
}
