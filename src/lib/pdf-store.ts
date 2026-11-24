import { convertToExcalidrawElements } from '@excalidraw/excalidraw';
import type { ExcalidrawElement, ExcalidrawImageElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFileData } from '@excalidraw/excalidraw/types';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { Board, PdfDocMeta } from '../types';
import { recordKey } from '../types';
import { db, touch } from './db';
import { blobToDataURL } from './assets';
import { downloadDriveImage } from './drive';
import { openPdf, pagePicture, pageTextContent, readPdf, textOf } from './pdf-engine';
import { MAX_PAGE_TEXT, PDF_MIME, pageSceneSize, pageSize, pdfDoc, pdfPageRef, type PageObjectData } from './pdf-model';
export { PDF_MIME, isPdfAsset } from './pdf-model';
import { DEFAULT_PEN_WIDTH } from './canvas-behavior';
import { snapState } from './snapping';

export const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
export const DOCUMENT_ACCEPT = `.pdf,.docx,${PDF_MIME},${DOCX_MIME}`;
export const MAX_DOCUMENT_BYTES = 150 * 1024 * 1024;
/** OCR never runs on pictures whose words are already known. */
const KNOWN_TEXT_VERSION = 1_000_000;

export const isDocumentFile = (file: File) => file.type === PDF_MIME || file.type === DOCX_MIME || /\.(pdf|docx)$/i.test(file.name);
async function sha256(data: ArrayBuffer | Blob) {
  const buffer = data instanceof Blob ? await data.arrayBuffer() : data;
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', buffer))).map(byte => byte.toString(16).padStart(2, '0')).join('');
}
const baseName = (name: string) => name.replace(/\.(pdf|docx)$/i, '').replace(/[_]+/g, ' ').trim().slice(0, 200) || 'Untitled document';

export interface ImportProgress { stage: 'converting' | 'reading' | 'saving'; done?: number; total?: number }
/**
 * Adds a PDF (or a Word .docx, converted on this device) as a document.
 * Its bytes stay on this device until sync uploads them with the images;
 * its page words are read once here for search.
 */
export async function importDocument({ file, scope, folderId, boardId, onProgress }: { file: File; scope: string; folderId: string | null; boardId?: string; onProgress?: (progress: ImportProgress) => void }): Promise<Board> {
  if (file.size > MAX_DOCUMENT_BYTES) throw new Error('This file is larger than 150 MB. Split it or compress it, then try again.');
  let bytes = await file.arrayBuffer(), source: PdfDocMeta['source'] = 'pdf';
  const head = new TextDecoder().decode(bytes.slice(0, 1024));
  if (!head.includes('%PDF')) {
    if (!/\.docx$/i.test(file.name) && file.type !== DOCX_MIME) throw new Error('Choose a PDF or a Word (.docx) file.');
    onProgress?.({ stage: 'converting' });
    const { docxToPdf } = await import('./docx-to-pdf');
    const pdf = await docxToPdf(bytes);
    bytes = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength) as ArrayBuffer; source = 'docx';
  }
  onProgress?.({ stage: 'reading', done: 0 });
  let info;
  try { info = await readPdf(bytes, (done, total) => onProgress?.({ stage: 'reading', done, total })); }
  catch (error) {
    const name = (error as Error)?.name;
    throw new Error(name === 'PasswordException' ? 'This PDF is password-protected. Remove the password, then add it again.' : 'This PDF could not be read. It may be damaged.');
  }
  onProgress?.({ stage: 'saving' });
  const fileId = `pdf-${await sha256(bytes)}`, key = recordKey(scope, fileId);
  const blob = new Blob([bytes], { type: PDF_MIME });
  const id = crypto.randomUUID(), timestamps = touch();
  const meta: PdfDocMeta = { fileId, pages: info.pages, fileName: file.name.slice(0, 240), bytes: blob.size, source, size: info.size, ...(info.odd ? { odd: info.odd } : {}), ...(boardId ? { boardId } : {}) };
  const board: Board = { key: recordKey(scope, id), id, scope, name: baseName(file.name), folderId, elements: [], appState: { notePdf: meta }, assetIds: [fileId], preview: null,
    ...timestamps, createdAt: timestamps.updatedAt, createdAtEstimated: false, deleted: false, remoteRevision: 0 };
  await db.transaction('rw', db.files, db.pdfText, db.assets, db.boards, async () => {
    if (!await db.files.get(key)) await db.files.put({ key, scope, id: fileId, blob });
    await db.pdfText.put({ key, scope, id: fileId, pages: info.texts });
    if (!await db.assets.get(key)) await db.assets.put({ key, id: fileId, scope, mimeType: PDF_MIME, created: Date.now(), storage: null, remotePath: null, ocrText: '', ocrStatus: 'done', ocrVersion: KNOWN_TEXT_VERSION, dirty: true });
    await db.boards.add(board);
  });
  return board;
}

const downloads = new Map<string, Promise<Blob>>();
/** The document's bytes: from this device, or downloaded once from its cloud storage. */
export function pdfBlob(client: SupabaseClient | null, scope: string, fileId: string): Promise<Blob> {
  const key = recordKey(scope, fileId);
  const running = downloads.get(key);
  if (running) return running;
  const work = (async () => {
    const local = await db.files.get(key);
    if (local?.blob?.size) return local.blob;
    const asset = await db.assets.get(key);
    if (!asset?.remotePath || !asset.storage) throw new Error('This document has not finished uploading. Open Note on the device where you added it and sync.');
    if (!client) throw new Error('Sign in to download this document.');
    let blob: Blob;
    if (asset.storage === 'drive') blob = await downloadDriveImage(asset.remotePath, scope);
    else {
      const { data, error } = await client.storage.from('note-images').download(asset.remotePath);
      if (error) throw error; blob = data;
    }
    const head = new TextDecoder().decode(await blob.slice(0, 1024).arrayBuffer());
    if (!head.includes('%PDF')) throw new Error('The downloaded file is not a PDF. Check the original file in its storage.');
    blob = new Blob([blob], { type: PDF_MIME });
    await db.files.put({ key, scope, id: fileId, blob });
    return blob;
  })();
  downloads.set(key, work);
  work.finally(() => downloads.delete(key)).catch(() => {});
  return work;
}
export const loadPdf = (client: SupabaseClient | null, scope: string, fileId: string) => openPdf(fileId, () => pdfBlob(client, scope, fileId));

/** Page words for search, read once per device (documents added elsewhere are read when first opened). */
export async function pdfTexts(scope: string, fileId: string, doc?: PDFDocumentProxy): Promise<string[] | null> {
  const key = recordKey(scope, fileId), stored = await db.pdfText.get(key);
  if (stored) return stored.pages;
  if (!doc) return null;
  const pages: string[] = [];
  for (let page = 1; page <= doc.numPages; page++) pages.push(textOf(await pageTextContent(doc, page)));
  await db.pdfText.put({ key, scope, id: fileId, pages });
  return pages;
}

/**
 * A page as a board picture: drawn at 1600 px, saved as an image whose words
 * are already known (so OCR never runs), and carrying its words for
 * Explain/Ask and search.
 */
export async function createPageObject({ scope, docBoard, doc, page, x, y, locked = false }: { scope: string; docBoard: Board; doc: PDFDocumentProxy; page: number; x: number; y: number; locked?: boolean }): Promise<{ element: ExcalidrawImageElement; file: BinaryFileData }> {
  const meta = pdfDoc(docBoard)!;
  const [blob, words] = await Promise.all([pagePicture(doc, page), pdfTexts(scope, meta.fileId, doc).then(pages => pages?.[page - 1] ?? '')]);
  const fileId = await sha256(blob), dataURL = await blobToDataURL(blob), key = recordKey(scope, fileId);
  const text = words.slice(0, MAX_PAGE_TEXT);
  if (!await db.assets.get(key)) await db.assets.put({ key, id: fileId, scope, dataURL, mimeType: 'image/webp', created: Date.now(), storage: null, remotePath: null, ocrText: text, ocrStatus: 'done', ocrVersion: KNOWN_TEXT_VERSION, dirty: true });
  const size = pageSize(meta, page), scene = pageSceneSize(size);
  const data: PageObjectData = { docId: docBoard.id, fileId: meta.fileId, page, name: docBoard.name, text, size };
  const [element] = convertToExcalidrawElements([{ type: 'image', x, y, ...scene, fileId: fileId as BinaryFileData['id'], status: 'saved', scale: [1, 1], locked, customData: { notePdfPage: data } }]) as ExcalidrawImageElement[];
  return { element, file: { id: fileId, dataURL, mimeType: 'image/webp', created: Date.now() } as BinaryFileData };
}

/** The annotation board of a document page: an infinite board with the page, locked, in the middle. */
export async function openPageBoard({ scope, docBoard, page, client, existing }: { scope: string; docBoard: Board; page: number; client: SupabaseClient | null; existing?: Board }): Promise<Board> {
  if (existing && !existing.deleted) return existing;
  const meta = pdfDoc(docBoard);
  if (!meta) throw new Error('This document is missing its file details.');
  const doc = await loadPdf(client, scope, meta.fileId);
  const scene = pageSceneSize(pageSize(meta, page));
  const { element } = await createPageObject({ scope, docBoard, doc, page, x: -scene.width / 2, y: -scene.height / 2, locked: true });
  const id = crypto.randomUUID(), timestamps = touch();
  const board: Board = { key: recordKey(scope, id), id, scope, name: `${docBoard.name} · page ${page}`, folderId: docBoard.folderId, elements: [element],
    appState: { notePdfPage: { docId: docBoard.id, page }, viewBackgroundColor: '#f4f3ef', currentItemFontFamily: 2, currentItemRoughness: 0, currentItemStrokeWidth: DEFAULT_PEN_WIDTH, ...snapState('off') },
    assetIds: [element.fileId!], preview: null, ...timestamps, createdAt: timestamps.updatedAt, createdAtEstimated: false, deleted: false, remoteRevision: 0 };
  await db.boards.add(board);
  return board;
}

/** A page board that never got a note is removed when left, so empty pages do not linger (only before it first syncs). */
export async function discardEmptyPageBoard(key: string) {
  await db.transaction('rw', db.boards, async () => {
    const board = await db.boards.get(key);
    if (!board || !pdfPageRef(board) || board.remoteRevision > 0) return;
    const visible = board.elements.filter((element: ExcalidrawElement) => !element.isDeleted);
    if (visible.length <= 1) await db.boards.delete(key);
  });
}
