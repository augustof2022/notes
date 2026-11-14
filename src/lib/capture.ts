/**
 * Snip and Camera tools: click the board where the picture goes, then snip an
 * area of a shared screen or window, or take a photo. These helpers hold the
 * geometry and sizing so the component only wires events and media.
 */
export const CAPTURE_TOOL = 'note-capture';
export type CaptureMode = 'snip' | 'camera';

/** Matches pasted screenshots, so snips and pastes land at the same size. */
export const MAX_BOARD_IMAGE_WIDTH = 650;
/** Phone photos are 12+ megapixels; this keeps text legible and boards light. */
export const MAX_PHOTO_EDGE = 2048;
/** Stop a kept-open screen share after this long without a snip. */
export const SHARE_IDLE_MS = 10 * 60 * 1000;

export interface Point { x: number; y: number }
export interface Rect { x: number; y: number; width: number; height: number }
export interface Size { width: number; height: number }

export function isCaptureTool(tool: { type: string; customType?: string | null }) {
  return tool.type === 'custom' && tool.customType === CAPTURE_TOOL;
}

type MediaNavigator = { mediaDevices?: { getDisplayMedia?: unknown; getUserMedia?: unknown } } | undefined;

/** Phones and tablets cannot share their screen from a browser. */
export function canSnip(nav: MediaNavigator = globalThis.navigator) {
  return typeof nav?.mediaDevices?.getDisplayMedia === 'function';
}

/**
 * Touch-only devices open their own camera app (better focus, flash, and
 * resolution). Desktops and laptops use an in-app viewfinder, since a file
 * input there only opens a file picker.
 */
export function usesNativeCamera(nav: MediaNavigator = globalThis.navigator, media: ((query: string) => { matches: boolean }) | undefined = globalThis.matchMedia?.bind(globalThis)) {
  if (typeof nav?.mediaDevices?.getUserMedia !== 'function') return true;
  if (!media) return false;
  return media('(pointer: coarse)').matches && !media('(any-pointer: fine)').matches;
}

/** Show a captured frame as large as the area allows, never above its real size. */
export function fitFrame(frame: Size, area: Rect, pixelRatio = 1): Rect {
  if (frame.width <= 0 || frame.height <= 0 || area.width <= 0 || area.height <= 0) return { x: area.x, y: area.y, width: 0, height: 0 };
  const scale = Math.min(area.width / frame.width, area.height / frame.height, 1 / Math.max(pixelRatio, 0.25));
  const width = frame.width * scale, height = frame.height * scale;
  return { x: area.x + (area.width - width) / 2, y: area.y + (area.height - height) / 2, width, height };
}

/** The rectangle between where a drag started and where it is now, any direction. */
export function dragRect(start: Point, end: Point): Rect {
  return { x: Math.min(start.x, end.x), y: Math.min(start.y, end.y), width: Math.abs(end.x - start.x), height: Math.abs(end.y - start.y) };
}

export function clampPoint(point: Point, rect: Rect): Point {
  return { x: Math.min(Math.max(point.x, rect.x), rect.x + rect.width), y: Math.min(Math.max(point.y, rect.y), rect.y + rect.height) };
}

/**
 * Map a selection drawn over the shown frame to whole pixels of the captured
 * frame. Returns null for a click or a sliver, so a stray tap does not insert.
 */
export function cropFromSelection(selection: Rect, shown: Rect, frame: Size, minimum = 4): Rect | null {
  if (shown.width <= 0 || shown.height <= 0) return null;
  const left = Math.max(selection.x, shown.x), top = Math.max(selection.y, shown.y);
  const right = Math.min(selection.x + selection.width, shown.x + shown.width), bottom = Math.min(selection.y + selection.height, shown.y + shown.height);
  if (right - left < minimum || bottom - top < minimum) return null;
  const sx = frame.width / shown.width, sy = frame.height / shown.height;
  const x = Math.max(0, Math.floor((left - shown.x) * sx)), y = Math.max(0, Math.floor((top - shown.y) * sy));
  const width = Math.min(frame.width, Math.ceil((right - shown.x) * sx)) - x, height = Math.min(frame.height, Math.ceil((bottom - shown.y) * sy)) - y;
  return width > 0 && height > 0 ? { x, y, width, height } : null;
}

/** Board size for a new picture: real pixels, narrowed like a pasted screenshot. */
export function boardImageSize(image: Size, maxWidth = MAX_BOARD_IMAGE_WIDTH): Size {
  const width = Math.min(maxWidth, image.width);
  return { width, height: image.height * width / image.width };
}

/** Whole-pixel size that fits within a longest edge, keeping the aspect ratio. */
export function fitWithin(image: Size, maxEdge = MAX_PHOTO_EDGE): Size {
  const scale = Math.min(1, maxEdge / Math.max(image.width, image.height));
  return { width: Math.max(1, Math.round(image.width * scale)), height: Math.max(1, Math.round(image.height * scale)) };
}

/** Describe what is being shared, for the status line. */
export function shareLabel(surface: string | undefined) {
  return surface === 'monitor' ? 'your screen' : surface === 'browser' ? 'a browser tab' : surface === 'window' ? 'a window' : 'your screen';
}

/** A cancelled picker or a denied permission is the user's choice, not an error. */
export function isCaptureCancel(error: unknown) {
  const name = (error as { name?: string } | null)?.name;
  return name === 'NotAllowedError' || name === 'AbortError';
}

/** Same content, same file id, as for pasted images, so sync stores it once. */
export async function imageFileId(blob: Blob) {
  const hash = await crypto.subtle.digest('SHA-256', await blob.arrayBuffer());
  return Array.from(new Uint8Array(hash)).map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export type SystemSnip = 'windows' | 'mac' | 'other';
type PlatformNavigator = { userAgent?: string; platform?: string; userAgentData?: { platform?: string } } | undefined;

/** Which built-in screenshot tool can hand a snip to Note through the clipboard. */
export function systemSnip(nav: PlatformNavigator = globalThis.navigator as PlatformNavigator): SystemSnip {
  const platform = `${nav?.userAgentData?.platform || ''} ${nav?.platform || ''} ${nav?.userAgent || ''}`;
  if (/Windows|Win32|Win64/i.test(platform)) return 'windows';
  if (/Mac/i.test(platform) && !/iPhone|iPad/i.test(platform)) return 'mac';
  return 'other';
}

/** X snips (like cut), C takes a photo. Plain keys only, so Ctrl+X and Ctrl+C keep working. */
export function captureShortcut(event: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean; shiftKey?: boolean; repeat?: boolean; isComposing?: boolean; defaultPrevented?: boolean }): CaptureMode | null {
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || event.repeat || event.isComposing || event.defaultPrevented) return null;
  const key = event.key.toLowerCase();
  return key === 'x' ? 'snip' : key === 'c' ? 'camera' : null;
}

/**
 * Accept a clipboard picture as the new snip only when it is not the picture
 * that was already there. Without a baseline, require that the screenshot
 * overlay took focus first, so an old clipboard image is not inserted.
 */
export function isNewSnip(hash: string, baseline: string | null | undefined, overlayOpened: boolean) {
  return baseline === undefined ? overlayOpened : hash !== baseline;
}

/** How long Note waits for a snip before giving up. */
export const SNIP_WAIT_MS = 2 * 60 * 1000;

let externalLaunchAt = 0;
/** Opening the Windows snip link looks like leaving the page; skip the leave warning briefly. */
export function markExternalLaunch(now = Date.now()) { externalLaunchAt = now; }
export function recentExternalLaunch(now = Date.now()) { return now - externalLaunchAt < 2000; }
