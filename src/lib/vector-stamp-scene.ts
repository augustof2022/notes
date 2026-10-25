import { convertToExcalidrawElements, mutateElement } from '@excalidraw/excalidraw';
import type { ExcalidrawElementSkeleton } from '@excalidraw/excalidraw/data/transform';
import type { ExcalidrawElement, ExcalidrawLinearElement } from '@excalidraw/excalidraw/element/types';
import { getStampIcon, normalizeStampPreferences, type IconStampData } from './vector-stamps';

/** Native grouped vectors need no image files and keep working in exports, sync and normal selection. */
export function buildIconStampSkeletons(
  iconId: string,
  center: { x: number; y: number },
  size = 48,
  color?: string,
): ExcalidrawElementSkeleton[] {
  if (!Number.isFinite(center.x) || !Number.isFinite(center.y)) throw new RangeError('Icon stamp position must be finite.');
  const preferences = normalizeStampPreferences({ iconId, size, color });
  const icon = getStampIcon(preferences.iconId), scale = preferences.size / 24;
  const origin = { x: center.x - preferences.size / 2, y: center.y - preferences.size / 2 };
  const instanceId = crypto.randomUUID();
  const data: IconStampData = { id: instanceId, iconId: icon.id, label: icon.label };
  const common = () => ({
    id: crypto.randomUUID(), strokeColor: preferences.color, backgroundColor: 'transparent',
    fillStyle: 'solid' as const, strokeWidth: Math.max(1.25, scale * 1.6), strokeStyle: 'solid' as const,
    roughness: 0, roundness: null, groupIds: [instanceId], customData: { noteIconStamp: { ...data } },
  });
  return icon.geometry.map(geometry => {
    if (geometry.type === 'ellipse') return {
      ...common(), type: 'ellipse', x: origin.x + geometry.x * scale, y: origin.y + geometry.y * scale,
      width: geometry.width * scale, height: geometry.height * scale,
    };
    const first = geometry.points[0];
    const xs = geometry.points.map(point => point[0]), ys = geometry.points.map(point => point[1]);
    return {
      ...common(), type: 'line', x: origin.x + first[0] * scale, y: origin.y + first[1] * scale,
      width: (Math.max(...xs) - Math.min(...xs)) * scale, height: (Math.max(...ys) - Math.min(...ys)) * scale,
      points: geometry.points.map(point => [(point[0] - first[0]) * scale, (point[1] - first[1]) * scale]) as ExcalidrawLinearElement['points'],
      startArrowhead: null, endArrowhead: null,
    };
  });
}

export function createIconStamp(iconId: string, center: { x: number; y: number }, size = 48, color?: string): ExcalidrawElement[] {
  const skeletons = buildIconStampSkeletons(iconId, center, size, color);
  const elements = convertToExcalidrawElements(skeletons, { regenerateIds: false });
  // Native resize uses width/height as well as points. Keep every polyline's
  // dimensions exact, including vertical lines and closed/curved icon outlines.
  for (const element of elements) {
    if (element.type !== 'line') continue;
    const points = element.points, xs = points.map(point => point[0]), ys = points.map(point => point[1]);
    mutateElement(element, { width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) }, false);
  }
  return elements;
}
