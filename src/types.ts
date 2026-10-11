import type { ExcalidrawElement } from '@excalidraw/excalidraw/element/types';
import type { AppState, BinaryFiles } from '@excalidraw/excalidraw/types';

export type ImageStore = 'supabase' | 'drive';
export interface RecordBase {
  key: string; id: string; scope: string; name: string;
  updatedAt: string; deleted: boolean; dirty: boolean; remoteRevision: number;
}
export interface Folder extends RecordBase { parentId: string | null; color: string }
export interface Board extends RecordBase {
  folderId: string | null; elements: readonly ExcalidrawElement[];
  appState: Partial<AppState> & { noteViewLock?: ViewLock | null }; assetIds: string[]; preview: string | null;
}
export type ViewLock = Pick<AppState, 'zoom'>;
export interface Asset {
  key: string; id: string; scope: string; dataURL?: string;
  mimeType: string; created: number; storage: ImageStore | null;
  remotePath: string | null; ocrText: string; ocrStatus: 'pending' | 'done' | 'failed';
  dirty: boolean;
  ocrVersion?: number;
  syncError?: string;
}
export interface Settings {
  supabaseUrl: string; supabaseKey: string;
  imageStore: ImageStore; ocrEnabled: boolean; theme: 'light' | 'dark';
}
export interface SearchMatch { board: Board; elementId?: string; text: string; kind: 'title' | 'text' | 'image' | 'handwriting' }
export type SceneFiles = BinaryFiles;
export const recordKey = (scope: string, id: string) => `${scope}:${id}`;
