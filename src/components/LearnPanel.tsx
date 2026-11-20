import { useEffect, useState } from 'react';
import { CaptureUpdateAction, convertToExcalidrawElements } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { BookOpen, ChevronRight, Globe, Minus, Send } from 'lucide-react';
import { isLearnNote, learnPage, readLearnPage, threadLabel, threadPath, type LearnPage } from '../lib/ask-ai-scene';
import type { LearnAsk } from './AskAiTools';
import './learn-panel.css';

interface View { id: string; elements: readonly ExcalidrawElement[] }

/**
 * The Learn panel turns an AI answer into a thread you can walk: its marked
 * terms are buttons that explain the term under it (in the sense of this
 * thread), a follow-up box continues this branch only, and the trail goes
 * back up to any earlier note or the page it started from. It also receives
 * pages sent by the Note Learn browser helper.
 */
export function LearnPanel({ api, root, onMessage }: { api: ExcalidrawImperativeAPI; root: HTMLElement | null; onMessage: (message: string) => void }) {
  const [view, setView] = useState<View | null>(null), [question, setQuestion] = useState(''), [hidden, setHidden] = useState(false);

  useEffect(() => {
    let frame = 0, last = '';
    const refresh = () => {
      frame = 0;
      const state = api.getAppState(), ids = Object.keys(state.selectedElementIds).filter(id => state.selectedElementIds[id]);
      const elements = api.getSceneElements(), chosen = ids.length === 1 ? elements.find(element => element.id === ids[0]) : undefined;
      const id = chosen && isLearnNote(chosen) && !state.editingTextElement ? chosen.id : '';
      const signature = id ? `${id}:${chosen!.version}` : '';
      if (signature === last) return;
      last = signature; setView(id ? { id, elements } : null);
      if (!id) setQuestion('');
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(refresh); };
    refresh();
    const stop = api.onChange(schedule);
    return () => { stop(); if (frame) cancelAnimationFrame(frame); };
  }, [api]);

  // Pages from the browser helper arrive as window messages from its content script on this origin.
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin || event.data?.type !== 'note-learn-page') return;
      const page = readLearnPage(event.data.page);
      window.postMessage({ type: 'note-learn-received', id: event.data.id }, window.location.origin);
      if (!page) return;
      placePage(api, page); setHidden(false);
      onMessage(`Added “${page.title}”. Ask about it in the Learn panel.`);
    };
    window.addEventListener('message', receive);
    window.postMessage({ type: 'note-learn-ready' }, window.location.origin);
    return () => window.removeEventListener('message', receive);
  }, [api]);

  if (!view) return null;
  const element = view.elements.find(item => item.id === view.id);
  if (!element) return null;
  const path = threadPath(view.elements, view.id), page = learnPage(element), terms: string[] = element.customData?.noteAi?.terms || [];
  const ask = (detail: LearnAsk) => root?.dispatchEvent(new CustomEvent<LearnAsk>('note-learn-ask', { detail }));
  const goTo = (target: ExcalidrawElement) => {
    api.updateScene({ appState: { selectedElementIds: { [target.id]: true }, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.NEVER });
    api.scrollToContent(target, { fitToContent: false, animate: true });
  };
  const send = () => { const text = question.trim(); if (!text) return; ask({ parentId: view.id, question: text }); setQuestion(''); };

  if (hidden) return <button type="button" className="learn-panel-tab" onClick={() => setHidden(false)} aria-label="Show Learn panel"><BookOpen size={15} /> Learn</button>;
  return <aside className="learn-panel" aria-label="Learn panel">
    <header><BookOpen size={16} /><h2>Learn</h2><button type="button" aria-label="Minimize Learn panel" title="Minimize" onClick={() => setHidden(true)}><Minus size={16} /></button></header>
    {path.length > 1 && <nav className="learn-trail" aria-label="Thread trail">
      {path.map((item, index) => <span key={item.id}>{index > 0 && <ChevronRight size={12} aria-hidden />}
        {item.id === view.id ? <strong>{threadLabel(item)}</strong> : <button type="button" onClick={() => goTo(item)} title="Go back to this note">{threadLabel(item)}</button>}</span>)}
    </nav>}
    {page && <p className="learn-page"><Globe size={14} /> <a href={page.url} target="_blank" rel="noreferrer">{page.title}</a></p>}
    {!!terms.length && <div className="learn-terms"><p>Tap a term to open its own thread:</p>
      <div>{terms.map(term => <button type="button" key={term} onClick={() => ask({ parentId: view.id, question: term, term })}>{term}</button>)}</div></div>}
    <form className="learn-ask" onSubmit={event => { event.preventDefault(); send(); }}>
      <label htmlFor="learn-question">{page ? 'Ask about this page' : 'Follow-up in this thread'}</label>
      <div><textarea id="learn-question" rows={2} value={question} placeholder={page ? 'What is this page saying about…?' : 'Why…? What about…?'}
        onChange={event => setQuestion(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); send(); } }} />
        <button type="submit" aria-label="Ask" disabled={!question.trim()}><Send size={15} /></button></div>
    </form>
  </aside>;
}

/** Put a sent page on the board as a card in the middle of the view, selected so the panel opens on it. */
function placePage(api: ExcalidrawImperativeAPI, page: LearnPage) {
  const state = api.getAppState(), fontSize = state.currentItemFontSize || 20;
  const url = page.url.length > 70 ? `${page.url.slice(0, 67)}…` : page.url;
  const quote = page.selection ? `\n“${page.selection.replace(/\s+/g, ' ').slice(0, 160)}${page.selection.length > 160 ? '…' : ''}”` : '';
  const [card] = convertToExcalidrawElements([{ type: 'text', text: `📄 ${page.title}\n${url}${quote}`, fontSize, fontFamily: state.currentItemFontFamily,
    x: state.width / 2 / state.zoom.value - state.scrollX - 200, y: state.height / 2 / state.zoom.value - state.scrollY - 40 }]);
  const element = { ...card, customData: { noteLearnPage: page } } as ExcalidrawElement;
  api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), element], appState: { selectedElementIds: { [element.id]: true }, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  requestAnimationFrame(() => api.scrollToContent(element, { fitToContent: false, animate: true }));
}
