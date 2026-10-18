import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { Modal } from './Modal';
import { needsTrashUpgrade, trashErrorMessage, type TrashSelection } from '../lib/trash';
import './trash.css';

export function DeleteTrashDialog({ selection, empty, cloud, onClose, onDelete }: {
  selection: TrashSelection; empty: boolean; cloud: boolean; onClose: () => void; onDelete: () => Promise<void>;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState<unknown>();
  const items = [...selection.folders, ...selection.boards];
  const counts = [selection.boards.length ? `${selection.boards.length} board${selection.boards.length === 1 ? '' : 's'}` : '', selection.folders.length ? `${selection.folders.length} folder${selection.folders.length === 1 ? '' : 's'}` : ''].filter(Boolean).join(' and ');
  return <Modal title={empty ? 'Empty Trash?' : 'Delete permanently?'} onClose={busy ? () => {} : onClose}>
    <p className="dialog-description">Permanently delete {counts}{cloud ? ' from your account and synced devices' : ' from this device'}? These items cannot be restored from Trash afterward.</p>
    <ul className="trash-delete-selection">{items.map(item => <li key={item.key}>{item.name}<small>{'elements' in item ? 'Board' : 'Folder'}</small></li>)}</ul>
    <p className="small-note">Image files are kept in their storage because other boards may use them.</p>
    {error !== undefined && <p className="form-error" role="alert">{trashErrorMessage(error)}{needsTrashUpgrade(error) && <> Download the <a href={`${import.meta.env.BASE_URL}enable-permanent-trash.sql`} download="enable-permanent-trash.sql">permanent-trash SQL update</a>, run it in Supabase → SQL Editor, then retry.</>}</p>}
    <div className="dialog-actions"><button className="secondary-button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary-button danger-button" disabled={busy} onClick={() => { setBusy(true); setError(undefined); void onDelete().catch(setError).finally(() => setBusy(false)); }}><Trash2 size={15} />{busy ? 'Deleting…' : empty ? 'Empty Trash' : 'Delete permanently'}</button></div>
  </Modal>;
}
