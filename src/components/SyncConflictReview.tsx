import { useState } from 'react';
import type { Board, Folder } from '../types';
import { BoardThumbnail } from './BoardThumbnail';

export function SyncConflictReview({ record, onResolve }: { record: Board | Folder; onResolve: (key: string, choice: 'local' | 'cloud', revision: number) => Promise<void> }) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const cloud = record.syncConflict?.data;
  if (!cloud) return null;
  function choose(choice: 'local' | 'cloud') {
    setBusy(true); setError('');
    void onResolve(record.key, choice, record.syncConflict!.revision).catch(error => setError(error instanceof Error ? error.message : 'Could not choose this version. Try again.')).finally(() => setBusy(false));
  }
  return <section className="sync-conflict-review" aria-label={`Review versions of ${record.name}`}>
    <p>Both devices changed the same item. Review the versions and choose which to keep.</p>
    <details><summary>Compare versions</summary><div className="sync-conflict-versions">
      {[{ label: 'This device', name: record.name, deleted: record.deleted, elements: 'elements' in record ? record.elements : null },
        { label: 'Cloud version', name: String(cloud.name || record.name), deleted: !!cloud.deleted, elements: Array.isArray(cloud.elements) ? cloud.elements as Board['elements'] : null }].map(version => <article key={version.label}><h4>{version.label}</h4><p>{version.name}{version.deleted ? ' · In Trash' : ''}</p>{version.elements && <><div className="sync-conflict-preview"><BoardThumbnail board={{ elements: version.elements }} /></div><small>{version.elements.filter(element => !element.isDeleted).length} {version.elements.filter(element => !element.isDeleted).length === 1 ? 'object' : 'objects'}</small><p>{version.elements.flatMap(element => element.type === 'text' && !element.isDeleted ? [element.text] : []).join(' · ').slice(0, 240)}</p></>}</article>)}
    </div></details>
    <div className="sync-conflict-actions"><button className="secondary-button" disabled={busy} onClick={() => choose('local')}>{busy ? 'Saving choice…' : 'Keep this device'}</button><button className="secondary-button" disabled={busy} onClick={() => choose('cloud')}>Use cloud version</button></div>
    {error && <p className="sync-item-error" role="alert">{error}</p>}
  </section>;
}
