import { expect, it } from 'vitest';
import { sceneSignature } from './canvas-signature';
const elements = [{ id: 'one', version: 4, versionNonce: 100, isDeleted: false }];
it('treats reordered cloud JSONB settings as the same scene, including nested values', () => {
  expect(sceneSignature(elements, { scrollX: 0, zoom: { value: 1 }, noteViewLock: { zoom: { value: 1 }, extra: 2 } })).toBe(
    sceneSignature(elements, { noteViewLock: { extra: 2, zoom: { value: 1 } }, zoom: { value: 1 }, scrollX: 0 }));
});
it('recognizes another device edit even when its element version number is equal', () => {
  expect(sceneSignature(elements, {})).not.toBe(sceneSignature([{ ...elements[0], versionNonce: 200 }], {}));
});
it('recognizes actual view and deletion changes', () => {
  expect(sceneSignature(elements, { zoom: { value: 1 } })).not.toBe(sceneSignature(elements, { zoom: { value: 2 } }));
  expect(sceneSignature(elements, {})).not.toBe(sceneSignature([{ ...elements[0], isDeleted: true }], {}));
});
import { contentFingerprint, elementsSignature } from './canvas-signature';
it('keeps the same content fingerprint for a pan or zoom, and changes it for any edit', () => {
  const scene = [{ id: 'a', version: 3, versionNonce: 11 }, { id: 'b', version: 7, versionNonce: 22 }];
  expect(contentFingerprint(scene)).toBe(contentFingerprint(scene.map(element => ({ ...element }))));
  expect(contentFingerprint(scene)).not.toBe(contentFingerprint([scene[0], { ...scene[1], version: 8, versionNonce: 23 }]));
  expect(contentFingerprint(scene)).not.toBe(contentFingerprint([scene[0]]));
  // An element mutated in place (as during a drag) is still detected.
  const live = scene.map(element => ({ ...element })), before = contentFingerprint(live);
  live[0].version++; live[0].versionNonce = 99;
  expect(contentFingerprint(live)).not.toBe(before);
});
it('builds the same scene signature from a cached element part', () => {
  const scene = [{ id: 'a', version: 1, versionNonce: 5, isDeleted: false }];
  expect(sceneSignature(scene, { zoom: 1 }, elementsSignature(scene))).toBe(sceneSignature(scene, { zoom: 1 }));
});
