import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types';

export type ImageStore = 'supabase' | 'drive';
export interface RecordBase {
  key: string; id: string; scope: string; name: string;
  createdAt?: string; createdAtEstimated?: boolean;
  updatedAt: string; deleted: boolean; dirty: boolean; remoteRevision: number; syncError?: string;
  purged?: boolean;
  syncBase?: { revision: number; data: Record<string, unknown> };
  syncConflict?: { revision: number; data: Record<string, unknown> };
}
export interface Folder extends RecordBase { parentId: string | null; color: string }
export interface Board extends RecordBase {
  folderId: string | null; elements: readonly ExcalidrawElement[];
  appState: Partial<AppState> & BoardDocumentState; assetIds: string[]; preview: string | null;
}
/**
 * Documents ride on board records so they sync, move, rename and go to Trash
 * like boards. `notePdf` marks a document (its pages live in one PDF file);
 * `notePdfPage` marks the private annotation board of one of its pages;
 * `noteReferences` lists library documents pinned to a board's reference bar.
 */
export interface BoardDocumentState { noteViewLock?: ViewLock | null; notePdf?: PdfDocMeta; notePdfPage?: PdfPageRef; noteReferences?: string[] }
export interface PdfDocMeta {
  fileId: string; pages: number; fileName: string; bytes: number; source: 'pdf' | 'docx';
  /** Page size in PDF points; `odd` lists pages whose size differs (1-based keys). */
  size: [number, number]; odd?: Record<string, [number, number]>;
  /** Set for a board-only reference: the board it belongs to. It never shows in the library. */
  boardId?: string;
}
export interface PdfPageRef { docId: string; page: number }
export type ViewLock = Pick<AppState, 'zoom'>;
export interface Asset {
  key: string; id: string; scope: string; dataURL?: string;
  mimeType: string; created: number; storage: ImageStore | null;
  remotePath: string | null; ocrText: string; ocrStatus: 'pending' | 'done' | 'failed';
  dirty: boolean;
  ocrVersion?: number;
  metadataSaved?: boolean;
  syncError?: string;
}
export interface Settings {
  imageStore: ImageStore; ocrEnabled: boolean; theme: 'light' | 'dark';
}
export interface SearchMatch { board: Board; elementId?: string; text: string; kind: 'title' | 'text' | 'image' | 'handwriting' | 'pdf' | 'pdf-notes'; page?: number; title?: string }
export type SceneFiles = BinaryFiles;
export const recordKey = (scope: string, id: string) => `${scope}:${id}`;
