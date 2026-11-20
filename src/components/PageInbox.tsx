import { useEffect } from 'react';
import { CaptureUpdateAction, convertToExcalidrawElements } from '@excalidraw/excalidraw';
import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { readLearnPage, type LearnPage } from '../lib/ask-ai-scene';

/** Deliveries already placed, so a page sent twice (helper retries, board remounts) lands once. */
const received = new Set<string>();

/**
 * Receives pages sent by the Note Learn browser helper (its content script
 * posts them on Note's own origin) and puts each on the board as a page card.
 * Select words in the card and use Explain or Ask, like any note.
 */
export function PageInbox({ api, onMessage }: { api: ExcalidrawImperativeAPI; onMessage: (message: string) => void }) {
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== window || event.origin !== window.location.origin || event.data?.type !== 'note-learn-page') return;
      const page = readLearnPage(event.data.page);
      window.postMessage({ type: 'note-learn-received', id: event.data.id }, window.location.origin);
      if (!page || received.has(String(event.data.id))) return;
      received.add(String(event.data.id));
      placePage(api, page);
      onMessage(`Added “${page.title}”. Double-click it, select words, then choose Explain or Ask.`);
    };
    window.addEventListener('message', receive);
    window.postMessage({ type: 'note-learn-ready' }, window.location.origin);
    return () => window.removeEventListener('message', receive);
  }, [api]);
  return null;
}
function wrapWords(text: string, width = 48) {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; } else line = line ? `${line} ${word}` : word;
  }
  return [...lines, line].join('\n');
}

/** Put a sent page on the board as a card in the middle of the view, selected. */
function placePage(api: ExcalidrawImperativeAPI, page: LearnPage) {
  const state = api.getAppState(), fontSize = state.currentItemFontSize || 20;
  const url = page.url.length > 70 ? `${page.url.slice(0, 67)}…` : page.url;
  const cut = page.title.slice(0, 100), title = page.title.length > 100 ? `${cut.slice(0, cut.lastIndexOf(' ') > 60 ? cut.lastIndexOf(' ') : 99).trimEnd()}…` : page.title;
  const quote = page.selection ? `\n${wrapWords(`“${page.selection.replace(/\s+/g, ' ').slice(0, 160)}${page.selection.length > 160 ? '…' : ''}”`)}` : '';
  const [card] = convertToExcalidrawElements([{ type: 'text', text: `📄 ${wrapWords(title)}\n${url}${quote}`, fontSize, fontFamily: state.currentItemFontFamily,
    x: state.width / 2 / state.zoom.value - state.scrollX - 200, y: state.height / 2 / state.zoom.value - state.scrollY - 40 }]);
  const element = { ...card, customData: { noteLearnPage: page } } as ExcalidrawElement;
  api.updateScene({ elements: [...api.getSceneElementsIncludingDeleted(), element], appState: { selectedElementIds: { [element.id]: true }, selectedGroupIds: {} }, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
  requestAnimationFrame(() => api.scrollToContent(element, { fitToContent: false, animate: true }));
}
