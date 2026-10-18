import { useCallback, useEffect, useRef, useState } from 'react';
import { liveQuery } from 'dexie';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types';
import { db } from '../lib/db';
import { recordKey } from '../types';
import { boardImageIds, loadBoardImages, type BoardImageState } from '../lib/board-images';

export function useBoardImages(api: ExcalidrawImperativeAPI | null, ready: boolean, boardKey: string, scope: string, client: SupabaseClient | null, onState: (state: BoardImageState) => void) {
  const [idsKey, setIdsKey] = useState('[]');
  const [metadata, setMetadata] = useState('');
  const callback = useRef(onState); callback.current = onState;
  const reload = useRef<() => Promise<void>>(async () => {});
  useEffect(() => {
    if (!api || !ready) return;
    const update = () => setIdsKey(previous => { const next = JSON.stringify(boardImageIds(api.getSceneElements())); return previous === next ? previous : next; });
    update(); return api.onChange(update);
  }, [api, ready]);
  useEffect(() => {
    const ids: string[] = JSON.parse(idsKey);
    const subscription = liveQuery(async () => {
      const rows = await db.assets.bulkGet(ids.map(id => recordKey(scope, id)));
      // File downloads do not change this signature. New cloud locations and
      // late metadata do, so they can recover images without a board revision.
      return JSON.stringify(rows.map(row => row ? [row.id, row.storage, row.remotePath] : null));
    }).subscribe({ next: setMetadata, error: () => {} });
    return () => subscription.unsubscribe();
  }, [scope, idsKey]);
  useEffect(() => {
    if (!api || !ready) return;
    let alive = true, inFlight: Promise<void> | null = null;
    const ids: string[] = JSON.parse(idsKey);
    const run = () => {
      if (inFlight) return inFlight;
      inFlight = loadBoardImages({ boardKey, scope, ids, client, files: api.getFiles(), isCurrent: () => alive,
        onFile: file => { if (alive && !api.getFiles()[file.id]) api.addFiles([file]); },
        onProgress: state => { if (alive) callback.current(state); }
      }).catch(error => {
        if (alive) callback.current({ boardKey, total: ids.length, loaded: ids.filter(id => !!api.getFiles()[id]).length, loading: false, issues: ids.filter(id => !api.getFiles()[id]).map(id => ({ id, reason: error instanceof Error ? error.message : 'Device image storage could not open. Retry images.', reconnect: false })) });
      }).finally(() => { inFlight = null; });
      return inFlight;
    };
    reload.current = run; void run();
    return () => { alive = false; if (reload.current === run) reload.current = async () => {}; };
  }, [api, ready, boardKey, scope, client, idsKey, metadata]);
  useEffect(() => {
    const wake = () => { if (document.visibilityState !== 'hidden') void reload.current(); };
    window.addEventListener('online', wake); window.addEventListener('focus', wake);
    document.addEventListener('visibilitychange', wake);
    return () => { window.removeEventListener('online', wake); window.removeEventListener('focus', wake); document.removeEventListener('visibilitychange', wake); };
  }, []);
  return useCallback(() => reload.current(), []);
}
