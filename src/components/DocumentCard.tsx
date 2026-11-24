import { useEffect, useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { ArrowUpRight, FileText, NotebookPen } from 'lucide-react';
import type { Board } from '../types';
import { recordKey } from '../types';
import { db } from '../lib/db';
import { pageThumb } from '../lib/pdf-engine';
import { loadPdf } from '../lib/pdf-store';
import { pdfDoc } from '../lib/pdf-model';

/** A document in the library: its first page (when the file is on this device), page count, and pages with notes. */
export function DocumentCard({ board, scope, client, annotated, place, date, onOpen }: { board: Board; scope: string; client: SupabaseClient | null; annotated: number; place: string; date: string; onOpen: () => void }) {
  const meta = pdfDoc(board)!;
  const [cover, setCover] = useState('');
  useEffect(() => {
    let alive = true;
    // Covers never download a document on their own; they appear once it has been opened here.
    void db.files.get(recordKey(scope, meta.fileId)).then(file => file ? loadPdf(client, scope, meta.fileId).then(doc => pageThumb(meta.fileId, doc, 1, 240)) : '')
      .then(url => { if (alive && url) setCover(url); }).catch(() => {});
    return () => { alive = false; };
  }, [meta.fileId, scope]);
  return <button className="board-card-main doc-card-main" onClick={onOpen}>
    <div className="board-thumbnail doc-thumbnail">
      <span className="doc-cover" style={{ aspectRatio: `${meta.size[0]} / ${meta.size[1]}` }}>{cover ? <img src={cover} alt="" draggable={false} /> : <FileText size={28} aria-hidden />}</span>
      <span className="doc-chip">{meta.source === 'docx' ? 'Word' : 'PDF'} · {meta.pages} page{meta.pages === 1 ? '' : 's'}</span>
      {annotated > 0 && <span className="doc-chip doc-chip-notes"><NotebookPen size={11} aria-hidden />{annotated} annotated</span>}
      <span className="thumbnail-open"><ArrowUpRight size={18} /></span>
    </div>
    <div className="board-card-info"><strong>{board.name}</strong><span>{place}<i />{date}</span></div>
  </button>;
}
