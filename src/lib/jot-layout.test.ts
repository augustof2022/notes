import { expect, it } from 'vitest';
import { jotIndent, jotLevel, jotPlacement } from './jot-layout';

const text = (patch: object = {}) => ({ id: 'a', type: 'text', x: 100, y: 100, width: 80, height: 27, fontSize: 20, customData: {}, ...patch });

it('puts a sibling directly below and a child one indent step in', () => {
  expect(jotPlacement(text(), 'sibling', [])).toEqual({ x: 100, y: 136, jot: { level: 0, step: 30 } });
  expect(jotPlacement(text(), 'child', [])).toEqual({ x: 130, y: 136, jot: { level: 1, step: 30 } });
});

it('skips past text already below so notes never overlap', () => {
  const below = text({ id: 'b', y: 136, height: 27 });
  expect(jotPlacement(text(), 'sibling', [below]).y).toBe(172);
  // Shapes and images are not text in the way, so jotting inside a box works.
  expect(jotPlacement(text(), 'sibling', [{ ...below, type: 'rectangle', height: 400 }]).y).toBe(136);
});

it('moves a note in and out a level, but not past the left edge', () => {
  const child = text({ x: 130, customData: { noteJot: { level: 1, step: 30 } } });
  expect(jotIndent(child, -1)).toEqual({ x: 100, jot: { level: 0, step: 30 } });
  expect(jotIndent(text(), -1)).toBeNull();
  expect(jotIndent(text(), 1)).toEqual({ x: 130, jot: { level: 1, step: 30 } });
  expect(jotLevel(text({ customData: { noteJot: { level: -2, step: 'x' } } }))).toEqual({ level: 0, step: 30 });
});
