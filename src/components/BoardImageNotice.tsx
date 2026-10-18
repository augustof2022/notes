import { Image, Loader2, RefreshCw } from 'lucide-react';
import { imageLoadLabel, type BoardImageState } from '../lib/board-images';
import './board-images.css';

export function BoardImageNotice({ state, onRetry, onReconnect }: { state: BoardImageState; onRetry: () => void; onReconnect: () => void }) {
  if (!state.total || (!state.loading && !state.issues.length)) return null;
  const reasons = [...new Set(state.issues.map(issue => issue.reason))];
  return <section className="board-image-notice" aria-label="Board image loading">
    <div className="board-image-summary" role="status">{state.loading ? <Loader2 size={16} className="spinning" /> : <Image size={16} />}<strong>{imageLoadLabel(state)}</strong></div>
    {state.loading && <p>Images appear as they arrive. Large files may take longer on a slow connection.</p>}
    {reasons.length > 0 && <details><summary>Why images are missing</summary>{reasons.map(reason => <p key={reason}>{reason}</p>)}</details>}
    <div className="board-image-actions">{state.issues.some(issue => issue.reconnect) && <button type="button" onClick={onReconnect}>Reconnect Google Drive</button>}<button type="button" disabled={state.loading} onClick={onRetry}><RefreshCw size={13} />Retry images</button></div>
  </section>;
}
