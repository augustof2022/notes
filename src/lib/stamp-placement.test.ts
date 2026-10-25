import { expect, it } from 'vitest';
import { ICON_STAMP_TOOL, isStampShortcut, isStampTool, stampGridTranslation, stampScenePoint } from './stamp-placement';

it('maps placement through editor offsets, panning, and zoom', () => {
  expect(stampScenePoint({ x: 520, y: 330 }, { offsetLeft: 120, offsetTop: 80, scrollX: -50, scrollY: 25, zoom: { value: 2 } })).toEqual({ x: 250, y: 100 });
});
it('snaps actual vector bounds as a group, preserving every relative position', () => {
  expect(stampGridTranslation([{ x: -13, y: 29 }, { x: 4, y: 35 }], 20)).toEqual({ x: -7, y: -9 });
  expect(stampGridTranslation([], 20)).toEqual({ x: 0, y: 0 });
});
it('reserves bare I for stamps while preserving modified keys and composition', () => {
  expect(isStampShortcut({ key: 'I' })).toBe(true);
  expect(isStampShortcut({ key: 'i' })).toBe(true);
  for (const flag of ['ctrlKey', 'metaKey', 'altKey', 'repeat', 'isComposing', 'defaultPrevented']) expect(isStampShortcut({ key: 'i', [flag]: true })).toBe(false);
  expect(isStampShortcut({ key: 'Image' })).toBe(false);
  expect(isStampTool({ type: 'custom', customType: ICON_STAMP_TOOL })).toBe(true);
  expect(isStampTool({ type: 'image' })).toBe(false);
});
