import { useEffect, useRef, useState } from 'react';
import { CaptureUpdateAction, exportToCanvas, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import type { SupabaseClient } from '@supabase/supabase-js';
import { Modal } from './Modal';
import { db } from '../lib/db';
import { downloadAsset } from '../lib/sync';
import { queueOcr } from '../lib/ocr';
import { createHandwritingReader } from '../lib/handwriting';
import { handwritingLines, handwritingSignature, indexedHandwriting } from '../lib/handwriting-index';
import type { Board } from '../types';
import { recordKey } from '../types';

export function ReadTextDialog({ api, board, client, onClose, onMessage }: { api: ExcalidrawImperativeAPI; board: Board; client: SupabaseClient | null; onClose: () => void; onMessage: (text: string) => void }) {
  const [mode, setMode] = useState<'choose' | 'handwriting'>('choose');
  const [busy, setBusy] = useState(false), [status, setStatus] = useState('');
  const [lines, setLines] = useState<{ ids: string[]; signature: string; preview: string; canvas: HTMLCanvasElement; text: string }[]>([]);
  const alive = useRef(true), reader = useRef<ReturnType<typeof createHandwritingReader> | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; reader.current?.close(); }; }, []);
  async function readImages() {
    setBusy(true); setStatus('Reading image text…');
    try {
      const ids = [...new Set(api.getSceneElements().flatMap(x => x.type === 'image' && !x.isDeleted && x.fileId ? [x.fileId] : []))];
      if (!ids.length) { setStatus('This board has no images to read.'); return; }
      // Flush is performed before opening this dialog, including newly pasted files.
      for (const id of ids) {
        let asset = await db.assets.get(recordKey(board.scope, id));
        if (!asset) continue;
        if (!asset.dataURL && client) { await downloadAsset(client, asset); asset = await db.assets.get(asset.key); }
        if (!asset?.dataURL) throw new Error('Reconnect image storage to download the images first.');
        await queueOcr(asset, { force: true });
      }
      if (alive.current) setStatus('Finished. Use Search to find recognized image text.');
    } catch (error) { if (alive.current) setStatus(error instanceof Error ? error.message : 'Could not read these images.'); }
    finally { if (alive.current) setBusy(false); }
  }
  async function prepareHandwriting() {
    setMode('handwriting'); setBusy(true); setStatus('Preparing handwriting lines…');
    try {
      const elements = api.getSceneElements(), groups = handwritingLines(elements, api.getAppState().selectedElementIds);
      if (groups.length > 20) throw new Error('Select a smaller area of handwriting, then open Read text again (up to 20 lines at once).');
      const prepared = [];
      for (const strokes of groups) {
        const canvas = await exportToCanvas({ elements: strokes.map(x => newElementWith(x, { strokeColor: '#111111', opacity: 100 })), files: {},
          appState: { exportBackground: true, viewBackgroundColor: '#ffffff', exportWithDarkMode: false }, exportPadding: 16,
          getDimensions: (width: number, height: number) => { const scale = Math.min(2, 1600 / Math.max(width, height)); return { width: width * scale, height: height * scale, scale }; } });
        prepared.push({ ids: strokes.map(x => x.id), signature: handwritingSignature(strokes), canvas, preview: canvas.toDataURL(), text: strokes.map(x => indexedHandwriting(x, elements)).find(Boolean) || '' });
      }
      if (alive.current) { setLines(prepared); setStatus(prepared.length ? 'Recognize the lines, review the words, then save. You can also type the words yourself.' : 'Write with the pen first, then reopen Read text.'); }
    } catch (error) { if (alive.current) setStatus(error instanceof Error ? error.message : 'Could not prepare handwriting.'); }
    finally { if (alive.current) setBusy(false); }
  }
  async function recognize() {
    setBusy(true); setStatus('Loading handwriting reader…');
    try {
      reader.current ||= createHandwritingReader(text => { if (alive.current) setStatus(text); });
      for (let i = 0; i < lines.length; i++) {
        setStatus(`Reading handwriting ${i + 1} of ${lines.length}…`);
        const text = await reader.current.read(lines[i].canvas);
        if (!alive.current) return;
        setLines(previous => previous.map((line, index) => index === i ? { ...line, text } : line));
      }
      setStatus('Review the words below. Correct anything the reader missed before saving.');
    } catch (error) { if (alive.current) { setStatus(`${error instanceof Error ? error.message : 'Recognition failed.'} You can still type the words below.`); reader.current?.close(); reader.current = null; } }
    finally { if (alive.current) setBusy(false); }
  }
  function save() {
    const elements = api.getSceneElements();
    // Clear earlier indexes touching these strokes to avoid duplicate/stale results.
    const ids = new Set(lines.flatMap(x => x.ids));
    const updated = elements.map(element => {
      const prior = element.customData?.noteHandwriting as { strokeIds?: string[] } | undefined;
      let customData = element.customData;
      if (prior?.strokeIds?.some(id => ids.has(id))) { customData = { ...customData }; delete customData.noteHandwriting; }
      const line = lines.find(x => x.ids[0] === element.id);
      if (line && line.text.trim()) customData = { ...customData, noteHandwriting: { text: line.text.trim(), strokeIds: line.ids, signature: line.signature } };
      return customData !== element.customData ? newElementWith(element, { customData }) : element;
    });
    api.updateScene({ elements: updated, captureUpdate: CaptureUpdateAction.IMMEDIATELY });
    onMessage('Handwriting text is searchable. Read it again after editing the strokes.'); onClose();
  }
  return <Modal title="Make this board searchable" wide onClose={onClose}>
    {mode === 'choose' ? <><p className="dialog-description">Read words in your images or handwriting. Recognition runs on your device, with no paid service.</p>
      <div className="read-text-options"><button className="secondary-button" disabled={busy} onClick={() => void readImages()}>Read image text</button><p>Printed English text in pasted screenshots and attached images. New images are read automatically when image search is enabled.</p>
      <button className="secondary-button" disabled={busy} onClick={() => void prepareHandwriting()}>Read handwriting</button><p>Reads selected pen strokes, or the board’s handwriting if none are selected. Review and save the recognized words for search.</p></div></> : <>
      <p className="dialog-description">Best with one handwritten line at a time. The free reader downloads about 90 MB on first use and caches it on this device. Accuracy varies; review the results.</p>
      <button className="secondary-button" disabled={busy || !lines.length} onClick={() => void recognize()}>Recognize handwriting</button>
      <div className="handwriting-lines">{lines.map((line, i) => <label key={line.ids[0]} className="handwriting-line"><img src={line.preview} alt={`Handwriting line ${i + 1}`} /><span>Searchable words — line {i + 1}</span><textarea disabled={busy} aria-label={`Searchable words for line ${i + 1}`} value={line.text} onChange={event => setLines(previous => previous.map((x, index) => i === index ? { ...x, text: event.target.value } : x))} /></label>)}</div>
      <button className="primary-button" disabled={busy || !lines.length} onClick={save}>Save searchable text</button></>}
    <p className="read-text-status" role="status">{status}</p>
  </Modal>;
}
