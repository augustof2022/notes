import { expect, it } from 'vitest';
import type { Board } from '../types';
import { canvasSaveAnchor, reconcileCanvasSave, recordData } from './sync-merge';
const element = (id: string, text = id) => ({ id, type: 'text', text, version: 1, versionNonce: 1, updated: 1, isDeleted: false });
const board = (): Board => ({ key: 'owner:board', id: 'board', scope: 'owner', name: 'Board', elements: [element('a')] as unknown as Board['elements'], appState: { scrollX: 0, viewBackgroundColor: '#fff' }, assetIds: [], folderId: null, preview: null, deleted: false, dirty: false, updatedAt: '2026-10-18T00:00:00Z', remoteRevision: 1 });
const checkpoint = (value: Board): Board => ({ ...value, syncBase: { revision: value.remoteRevision, data: recordData(value) } });
it('retains a just-downloaded scene when an older pending canvas snapshot only changes the view', () => {
  const anchor = checkpoint(board()), remote = checkpoint({ ...anchor, elements: [element('a', 'Other device')] as unknown as Board['elements'], remoteRevision: 2 });
  const saved = reconcileCanvasSave(anchor, { ...anchor, appState: { ...anchor.appState, scrollX: 500 } }, remote);
  expect(saved).toMatchObject({ elements: [{ text: 'Other device' }], appState: { scrollX: 500 }, remoteRevision: 2, dirty: false, updatedAt: remote.updatedAt });
});
it('merges a local scene edit against the actually applied baseline when the database advanced before paint', () => {
  const anchor = checkpoint(board()), remote = checkpoint({ ...anchor, elements: [...anchor.elements, element('phone')] as unknown as Board['elements'], remoteRevision: 2 });
  const saved = reconcileCanvasSave(anchor, { ...anchor, elements: [element('a', 'Laptop edit')] as unknown as Board['elements'] }, remote);
  expect(saved).toMatchObject({ elements: [{ text: 'Laptop edit' }, { id: 'phone' }], remoteRevision: 2, dirty: true, syncBase: remote.syncBase });
});
it('forces revision-checked review of overlapping edits that arrive before the canvas receives the cloud scene', () => {
  const anchor = checkpoint(board()), remote = checkpoint({ ...anchor, elements: [element('a', 'Phone edit')] as unknown as Board['elements'], remoteRevision: 2 });
  const saved = reconcileCanvasSave(anchor, { ...anchor, elements: [element('a', 'Laptop edit')] as unknown as Board['elements'] }, remote);
  expect(saved).toMatchObject({ elements: [{ text: 'Laptop edit' }], remoteRevision: 1, syncBase: anchor.syncBase, dirty: true });
});
it('keeps the acknowledged checkpoint across sequential local saves during a network request', () => {
  const original = checkpoint(board());
  const first = reconcileCanvasSave(original, { ...original, elements: [element('a', 'First local edit')] as unknown as Board['elements'] }, original);
  const acknowledged = checkpoint({ ...first, dirty: false, remoteRevision: 2 });
  const next = reconcileCanvasSave(first, { ...first, elements: [element('a', 'Next local edit')] as unknown as Board['elements'] }, acknowledged);
  expect(next).toMatchObject({ elements: [{ text: 'Next local edit' }], remoteRevision: 2, syncBase: acknowledged.syncBase, dirty: true });
});
it('never writes an old canvas snapshot over a permanent deletion', () => {
  const anchor = checkpoint(board()), purged = { ...anchor, purged: true, deleted: true, elements: [], appState: {}, assetIds: [], remoteRevision: 3, dirty: false };
  expect(reconcileCanvasSave(anchor, { ...anchor, elements: [element('a', 'Unsaved')] as unknown as Board['elements'] }, purged)).toBe(purged);
});
it('keeps a pre-paint remote addition across consecutive queued local snapshots', () => {
  const original = checkpoint(board());
  const remote = checkpoint({ ...original, elements: [...original.elements, element('phone')] as unknown as Board['elements'], remoteRevision: 2 });
  const firstInput = { ...original, elements: [element('a', 'First local input')] as unknown as Board['elements'] };
  const first = reconcileCanvasSave(original, firstInput, remote);
  expect(first.elements.map(item => item.id)).toEqual(['a', 'phone']);
  // The database merged the phone element; the actual canvas still shows only
  // its own input until the clean remote-update effect paints the merged scene.
  const appliedAnchor = canvasSaveAnchor(original, first, firstInput);
  const next = reconcileCanvasSave(appliedAnchor, { ...firstInput, elements: [element('a', 'Next local input')] as unknown as Board['elements'] }, first);
  expect(next.elements.map(item => item.id)).toEqual(['a', 'phone']);
  expect(next.elements[0]).toMatchObject({ text: 'Next local input' });
  expect(next.remoteRevision).toBe(2);
});

it('retains the actually viewed revision after a view-only save so an overlapping unseen edit requires review', () => {
  const original = checkpoint(board());
  const remote = checkpoint({ ...original, elements: [element('a', 'Unpainted phone edit')] as unknown as Board['elements'], remoteRevision: 2 });
  const viewInput = { ...original, appState: { ...original.appState, scrollX: 900 } };
  const viewSaved = reconcileCanvasSave(original, viewInput, remote);
  expect(viewSaved.remoteRevision).toBe(2);
  const appliedAnchor = canvasSaveAnchor(original, viewSaved, viewInput);
  expect(appliedAnchor).toMatchObject({ remoteRevision: 1, syncBase: original.syncBase, elements: [{ text: 'a' }] });
  const actualEdit = { ...viewInput, elements: [element('a', 'New laptop input')] as unknown as Board['elements'] };
  const saved = reconcileCanvasSave(appliedAnchor, actualEdit, viewSaved);
  expect(saved).toMatchObject({ remoteRevision: 1, syncBase: original.syncBase, elements: [{ text: 'New laptop input' }], dirty: true });
});
it('does not mark a restored empty binding list as an edit when panning', () => {
  const original = checkpoint({ ...board(), elements: [{ ...element('a'), boundElements: null }] as unknown as Board['elements'] });
  const snapshot = { ...original, elements: [{ ...element('a'), boundElements: [] }] as unknown as Board['elements'], appState: { ...original.appState, scrollX: 250 } };
  const saved = reconcileCanvasSave(original, snapshot, original);
  expect(saved).toMatchObject({ dirty: false, remoteRevision: 1, updatedAt: original.updatedAt, appState: { scrollX: 250 } });
});
it('keeps generated stacking indices local while treating an actual array reorder as an edit', () => {
  const original = checkpoint({ ...board(), elements: [element('a'), element('b')] as unknown as Board['elements'] });
  const restored = { ...original, elements: original.elements.map((item, index) => ({ ...item, index: `a${index}`, version: 2, versionNonce: index + 10, updated: 2 })) as unknown as Board['elements'] };
  const saved = reconcileCanvasSave(original, restored, original);
  expect(saved).toMatchObject({ dirty: false, remoteRevision: 1, updatedAt: original.updatedAt });
  const reordered = reconcileCanvasSave(original, { ...restored, elements: [...restored.elements].reverse() }, original);
  expect(reordered.dirty).toBe(true);
  expect(reordered.elements.map(item => item.id)).toEqual(['b', 'a']);
});
