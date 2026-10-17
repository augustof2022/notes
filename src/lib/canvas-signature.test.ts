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
