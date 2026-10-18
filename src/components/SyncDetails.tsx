import { createPortal } from 'react-dom';
import { RefreshCw } from 'lucide-react';
import type { PendingSyncItem } from '../lib/sync-status';
import { pendingSyncLabel } from '../lib/sync-status';
import { needsCreationDateRepair } from '../lib/sync-save';
import { imageLoadLabel, type BoardImageState } from '../lib/board-images';
import { Modal } from './Modal';
import './sync-details.css';

export function SyncDetails({ account, status, pending, syncing, lastChecked, lastSynced, images, onRetryImages, onSync, onClose }: {
  account: string; status: string; pending: PendingSyncItem[]; syncing: boolean;
  images?: BoardImageState; onRetryImages?: () => void;
  lastChecked: number | null; lastSynced: number | null; onSync: () => Promise<void>; onClose: () => void;
}) {
  return createPortal(<Modal title="Sync details" onClose={onClose}>
    <p className="dialog-description sync-account">Account: <strong>{account}</strong>. Use this same Note account on your other devices.</p>
    <p className="sync-current-status" role="status">{syncing ? `Syncing · ${status}` : status}</p>
    <dl className="sync-times"><div><dt>Last cloud check</dt><dd>{lastChecked ? new Date(lastChecked).toLocaleTimeString() : 'Not checked in this session'}</dd></div><div><dt>Last completed sync</dt><dd>{lastSynced ? new Date(lastSynced).toLocaleTimeString() : 'Not completed in this session'}</dd></div></dl>
    {needsCreationDateRepair([status, ...pending.map(item => item.reason)].join('\n')) && <p className="small-note">The cloud database needs a creation-date update. The project owner can run the <a href={`${import.meta.env.BASE_URL}repair-creation-dates.sql`} download="repair-creation-dates.sql">creation-date repair script</a> in Supabase → SQL Editor, then choose Sync now. This preserves existing boards and files.</p>}
    {pending.length > 0 ? <><h3 className="sync-pending-title">{pendingSyncLabel(pending)} pending</h3><ul className="sync-pending-list">{pending.map(item => <li key={`${item.kind}:${item.key}`}><strong>{item.name}<small>{item.kind}</small></strong><p className={item.failed ? 'sync-item-error' : ''}>{item.reason}</p></li>)}</ul></> : <p className="small-note">No local uploads are waiting. Sync now also checks for changes from your other devices.</p>}
    {images && images.total > 0 && <section className="sync-image-details" aria-label="Images on this board"><h3>Images on this board</h3><p role="status">{imageLoadLabel(images)}</p><p className="small-note">Board sync saves your notes and image locations. Image files download when you open the board, then stay cached on this device.</p>{[...new Set(images.issues.map(issue => issue.reason))].map(reason => <p className="sync-item-error" key={reason}>{reason}</p>)}{images.issues.length > 0 && <button className="secondary-button" disabled={images.loading} onClick={onRetryImages}>Retry images</button>}</section>}
    <p className="small-note">While Note is open and online, changes upload shortly after editing and devices check for updates every 15 seconds. Returning to the app checks again. Images must finish uploading on the device where you added them.</p>
    <div className="dialog-actions"><button className="secondary-button" onClick={onClose}>Close</button><button className="primary-button" disabled={syncing} onClick={() => void onSync()}><RefreshCw size={15} />{syncing ? 'Syncing…' : 'Sync now'}</button></div>
  </Modal>, document.body);
}
