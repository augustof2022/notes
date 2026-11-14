import { describe, expect, it } from 'vitest';
import { boardImageSize, canSnip, captureShortcut, clampPoint, cropFromSelection, dragRect, fitFrame, fitWithin, imageFileId, isCaptureCancel, isCaptureTool, isNewSnip, markExternalLaunch, recentExternalLaunch, shareLabel, systemSnip, usesNativeCamera } from './capture';

describe('capture tool detection', () => {
  it('recognizes only its own custom tool', () => {
    expect(isCaptureTool({ type: 'custom', customType: 'note-capture' })).toBe(true);
    expect(isCaptureTool({ type: 'custom', customType: 'note-icon-stamp' })).toBe(false);
    expect(isCaptureTool({ type: 'image' })).toBe(false);
  });
  it('offers Snip only where the browser can share a screen', () => {
    expect(canSnip({ mediaDevices: { getDisplayMedia: () => {} } })).toBe(true);
    expect(canSnip({ mediaDevices: {} })).toBe(false);
    expect(canSnip(undefined)).toBe(false);
  });
  it('opens the phone camera app on touch-only devices and a viewfinder elsewhere', () => {
    const media = (coarse: boolean, fine: boolean) => (query: string) => ({ matches: query.includes('any-pointer') ? fine : coarse });
    const nav = { mediaDevices: { getUserMedia: () => {} } };
    expect(usesNativeCamera(nav, media(true, false))).toBe(true);
    expect(usesNativeCamera(nav, media(true, true))).toBe(false);
    expect(usesNativeCamera(nav, media(false, true))).toBe(false);
    expect(usesNativeCamera({ mediaDevices: {} }, media(false, true))).toBe(true);
  });
});

describe('snip geometry', () => {
  it('fits a large frame inside the area, centered', () => {
    expect(fitFrame({ width: 2000, height: 1000 }, { x: 0, y: 50, width: 1000, height: 1000 })).toEqual({ x: 0, y: 300, width: 1000, height: 500 });
  });
  it('never enlarges a frame beyond its real size on high-density screens', () => {
    expect(fitFrame({ width: 600, height: 300 }, { x: 0, y: 0, width: 1000, height: 1000 }, 2)).toEqual({ x: 350, y: 425, width: 300, height: 150 });
  });
  it('normalizes drags in any direction and clamps points to the frame', () => {
    expect(dragRect({ x: 50, y: 80 }, { x: 10, y: 20 })).toEqual({ x: 10, y: 20, width: 40, height: 60 });
    expect(clampPoint({ x: -5, y: 500 }, { x: 0, y: 0, width: 100, height: 100 })).toEqual({ x: 0, y: 100 });
  });
  it('maps a selection on a scaled-down frame to real frame pixels', () => {
    const shown = { x: 100, y: 50, width: 960, height: 540 };
    expect(cropFromSelection({ x: 100, y: 50, width: 480, height: 270 }, shown, { width: 1920, height: 1080 })).toEqual({ x: 0, y: 0, width: 960, height: 540 });
    expect(cropFromSelection({ x: 580, y: 320, width: 1000, height: 1000 }, shown, { width: 1920, height: 1080 })).toEqual({ x: 960, y: 540, width: 960, height: 540 });
  });
  it('ignores a click or a sliver instead of inserting it', () => {
    const shown = { x: 0, y: 0, width: 100, height: 100 };
    expect(cropFromSelection({ x: 10, y: 10, width: 0, height: 0 }, shown, { width: 100, height: 100 })).toBeNull();
    expect(cropFromSelection({ x: 10, y: 10, width: 50, height: 2 }, shown, { width: 100, height: 100 })).toBeNull();
    expect(cropFromSelection({ x: 200, y: 200, width: 50, height: 50 }, shown, { width: 100, height: 100 })).toBeNull();
  });
});

describe('picture sizing', () => {
  it('keeps small snips at real size and narrows wide ones like pasted screenshots', () => {
    expect(boardImageSize({ width: 300, height: 120 })).toEqual({ width: 300, height: 120 });
    expect(boardImageSize({ width: 1300, height: 500 })).toEqual({ width: 650, height: 250 });
  });
  it('shrinks large photos to the longest-edge limit', () => {
    expect(fitWithin({ width: 4032, height: 3024 })).toEqual({ width: 2048, height: 1536 });
    expect(fitWithin({ width: 800, height: 600 })).toEqual({ width: 800, height: 600 });
  });
});

describe('capture messages and ids', () => {
  it('treats a closed picker or denied permission as a cancel', () => {
    expect(isCaptureCancel({ name: 'NotAllowedError' })).toBe(true);
    expect(isCaptureCancel({ name: 'AbortError' })).toBe(true);
    expect(isCaptureCancel(new Error('boom'))).toBe(false);
  });
  it('names the shared surface', () => {
    expect(shareLabel('window')).toBe('a window');
    expect(shareLabel('monitor')).toBe('your screen');
  });
  it('gives identical pictures the same file id', async () => {
    const a = await imageFileId(new Blob([new Uint8Array([1, 2, 3])]));
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(await imageFileId(new Blob([new Uint8Array([1, 2, 3])]))).toBe(a);
  });
});

describe('system snip and shortcuts', () => {
  it('detects the screenshot tool by platform', () => {
    expect(systemSnip({ userAgentData: { platform: 'Windows' } })).toBe('windows');
    expect(systemSnip({ userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' })).toBe('windows');
    expect(systemSnip({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5)' })).toBe('mac');
    expect(systemSnip({ userAgent: 'Mozilla/5.0 (X11; Linux x86_64)' })).toBe('other');
  });
  it('uses plain X for Snip and C for Camera, leaving Ctrl+X and Ctrl+C alone', () => {
    expect(captureShortcut({ key: 'x' })).toBe('snip');
    expect(captureShortcut({ key: 'C' })).toBe('camera');
    expect(captureShortcut({ key: 'x', ctrlKey: true })).toBeNull();
    expect(captureShortcut({ key: 'c', metaKey: true })).toBeNull();
    expect(captureShortcut({ key: 'x', repeat: true })).toBeNull();
    expect(captureShortcut({ key: 'v' })).toBeNull();
  });
  it('ignores the picture that was already on the clipboard', () => {
    expect(isNewSnip('a', 'a', true)).toBe(false);
    expect(isNewSnip('b', 'a', false)).toBe(true);
    expect(isNewSnip('b', null, false)).toBe(true);
    expect(isNewSnip('b', undefined, false)).toBe(false);
    expect(isNewSnip('b', undefined, true)).toBe(true);
  });
  it('remembers an external launch for a moment', () => {
    markExternalLaunch(1000);
    expect(recentExternalLaunch(2500)).toBe(true);
    expect(recentExternalLaunch(3500)).toBe(false);
  });
});
