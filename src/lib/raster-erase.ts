import { convertToExcalidrawElements, exportToCanvas, getCommonBounds, newElementWith } from '@excalidraw/excalidraw';
import type { ExcalidrawElement, ExcalidrawImageElement, NonDeleted } from '@excalidraw/excalidraw/element/types';
import type { BinaryFileData, BinaryFiles } from '@excalidraw/excalidraw/types';
import { boardObjects, flattenObjects, objectOwner } from './board-objects';
import type { InkPoint } from './ink-geometry';

export interface EraseSegment { from: InkPoint; to: InkPoint; radius: number }
export interface ErasedObject {
  before: ExcalidrawElement[]; after: Map<string, ExcalidrawElement>; file?: BinaryFileData; converted: boolean; detachedArrow?: string;
}
export interface RasterEraseResult { objects: ErasedObject[]; skipped: number }

export function eraseBounds(segments: readonly EraseSegment[]): [number, number, number, number] {
  const bounds: [number, number, number, number] = [Infinity, Infinity, -Infinity, -Infinity];
  for (const segment of segments) {
    bounds[0] = Math.min(bounds[0], segment.from[0] - segment.radius, segment.to[0] - segment.radius);
    bounds[1] = Math.min(bounds[1], segment.from[1] - segment.radius, segment.to[1] - segment.radius);
    bounds[2] = Math.max(bounds[2], segment.from[0] + segment.radius, segment.to[0] + segment.radius);
    bounds[3] = Math.max(bounds[3], segment.from[1] + segment.radius, segment.to[1] + segment.radius);
  }
  return bounds;
}
export function intersectsErase(bounds: readonly number[], stroke: readonly number[]) { return bounds[0] <= stroke[2] && bounds[2] >= stroke[0] && bounds[1] <= stroke[3] && bounds[3] >= stroke[1]; }
export function nativeInk(element: ExcalidrawElement) { return element.type === 'freedraw' && (!element.backgroundColor || element.backgroundColor === 'transparent'); }

/** Limit rendering memory while preserving original image resolution when possible. */
export function eraseRenderScale(width: number, height: number, preferred = 4) {
  return Math.min(preferred, 8192 / Math.max(1, width, height), Math.sqrt(8 * 1024 * 1024 / Math.max(1, width * height)));
}

/** Build cutouts off-scene, then let the caller commit a complete gesture atomically. */
export async function eraseRasterObjects(elements: readonly ExcalidrawElement[], files: BinaryFiles, segments: readonly EraseSegment[]): Promise<RasterEraseResult> {
  const result: RasterEraseResult = { objects: [], skipped: 0 };
  if (!segments.length) return result;
  const scene = structuredClone(elements), strokeBounds = eraseBounds(segments), visible = scene.filter(e => !e.isDeleted), byId = new Map(visible.map(e => [e.id, e]));
  const objects = flattenObjects(boardObjects(scene)).filter(object => !object.children.length);
  for (const object of objects) {
    const members = object.elementIds.flatMap(id => byId.get(id) || []), primary = objectOwner(members[0], byId);
    if (!primary || nativeInk(primary) || object.partlyLocked || !['rectangle', 'ellipse', 'diamond', 'line', 'arrow', 'text', 'image', 'freedraw'].includes(primary.type)) continue;
    const bounds = getCommonBounds(members), padding = primary.type === 'image' && members.length === 1 ? 0 : Math.max(2, ...members.map(e => (e.strokeWidth || 0) / 2 + (e.roughness || 0)));
    const box = [bounds[0] - padding, bounds[1] - padding, bounds[2] + padding, bounds[3] + padding];
    if (!intersectsErase(box, strokeBounds) || members.every(e => !e.opacity)) continue;
    if (members.some(e => e.type === 'image' && (!e.fileId || !files[e.fileId]?.dataURL))) { result.skipped++; continue; }
    try {
      const snapshot = structuredClone(members), opacity = members.every(e => e.opacity === primary.opacity) ? primary.opacity : 100;
      if (opacity > 0 && opacity < 100) for (const member of snapshot) Object.assign(member, { opacity: member.opacity / opacity * 100 });
      let preferred = 4;
      if (primary.type === 'image' && primary.fileId && files[primary.fileId]?.mimeType !== 'image/svg+xml') {
        const image = await createImageBitmap(await (await fetch(files[primary.fileId].dataURL)).blob());
        preferred = Math.max(image.width / Math.max(1, primary.width), image.height / Math.max(1, primary.height)); image.close();
      }
      const canvas = await exportToCanvas({ elements: snapshot as NonDeleted<ExcalidrawElement>[], files, exportPadding: padding,
        appState: { exportBackground: false, exportWithDarkMode: false }, getDimensions: (width: number, height: number) => {
          const scale = eraseRenderScale(width, height, preferred); return { width: Math.ceil(width * scale), height: Math.ceil(height * scale), scale };
        } });
      const width = box[2] - box[0], height = box[3] - box[1], sx = canvas.width / Math.max(0.01, width), sy = canvas.height / Math.max(0.01, height);
      const context = canvas.getContext('2d', { willReadFrequently: true })!;
      const left = Math.max(0, Math.floor((strokeBounds[0] - box[0]) * sx)), top = Math.max(0, Math.floor((strokeBounds[1] - box[1]) * sy));
      const right = Math.min(canvas.width, Math.ceil((strokeBounds[2] - box[0]) * sx)), bottom = Math.min(canvas.height, Math.ceil((strokeBounds[3] - box[1]) * sy));
      if (right <= left || bottom <= top) continue;
      const before = context.getImageData(left, top, right - left, bottom - top).data;
      context.save(); context.setTransform(sx, 0, 0, sy, -box[0] * sx, -box[1] * sy);
      context.globalCompositeOperation = 'destination-out'; context.strokeStyle = '#000'; context.fillStyle = '#000'; context.lineCap = 'round'; context.lineJoin = 'round';
      for (const segment of segments) {
        context.lineWidth = segment.radius * 2;
        if (segment.from[0] === segment.to[0] && segment.from[1] === segment.to[1]) { context.beginPath(); context.arc(segment.to[0], segment.to[1], segment.radius, 0, Math.PI * 2); context.fill(); }
        else { context.beginPath(); context.moveTo(...segment.from); context.lineTo(...segment.to); context.stroke(); }
      }
      context.restore();
      const after = context.getImageData(left, top, right - left, bottom - top).data;
      let changed = false;
      for (let i = 3; i < after.length; i += 4) if (before[i] !== after[i]) { changed = true; break; }
      if (!changed) continue; // A swipe through a hollow shape does not flatten it.
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let remains = false; for (let i = 3; i < pixels.length; i += 4) if (pixels[i]) { remains = true; break; }
      const changes = new Map<string, ExcalidrawElement>();
      if (!remains) for (const member of members) changes.set(member.id, newElementWith(member, { isDeleted: true }));
      else {
        const fileId = `note-cutout-${crypto.randomUUID()}` as BinaryFileData['id'];
        const file: BinaryFileData = { id: fileId, dataURL: canvas.toDataURL('image/png') as BinaryFileData['dataURL'], mimeType: 'image/png', created: Date.now() };
        const customData: Record<string, any> = { ...primary.customData, noteErasedFrom: primary.customData?.noteErasedFrom || { kind: object.kind, label: object.label } };
        delete customData.noteDiagram; delete customData.noteRichText; delete customData.noteRichTextRender; delete customData.noteHandwriting;
        const [created] = convertToExcalidrawElements([{ id: primary.id, type: 'image', x: box[0], y: box[1], width, height, fileId, status: 'saved', scale: [1, 1] }], { regenerateIds: false });
        const image = newElementWith({ ...created, version: primary.version } as ExcalidrawImageElement, { x: box[0], y: box[1], width, height, opacity, index: primary.index,
          groupIds: primary.groupIds, frameId: primary.frameId, link: primary.link, locked: false, customData, boundElements: (primary.boundElements || []).filter(e => e.type === 'arrow') });
        changes.set(primary.id, image);
        for (const member of members) if (member.id !== primary.id) changes.set(member.id, newElementWith(member, { isDeleted: true }));
        result.objects.push({ before: members, after: changes, file, converted: primary.type !== 'image' });
      }
      if (!remains) result.objects.push({ before: members, after: changes, converted: false });
      if (primary.type === 'arrow') result.objects.at(-1)!.detachedArrow = primary.id;
    } catch { result.skipped++; }
  }
  return result;
}

export function applyErasedObjects(elements: readonly ExcalidrawElement[], result: RasterEraseResult) {
  const current = new Map(elements.map(e => [e.id, e])), edits = new Map<string, ExcalidrawElement>(), files: BinaryFileData[] = [];
  const detached = new Set<string>();
  let converted = false, skipped = result.skipped;
  for (const object of result.objects) {
    if (object.before.some(before => { const now = current.get(before.id); return !now || now.version !== before.version || now.versionNonce !== before.versionNonce || now.isDeleted !== before.isDeleted; })) { skipped++; continue; }
    for (const [id, element] of object.after) edits.set(id, element);
    if (object.detachedArrow) detached.add(object.detachedArrow);
    if (object.file) files.push(object.file); converted ||= object.converted;
  }
  return { elements: elements.map(original => {
    const element = edits.get(original.id) || original;
    return element.boundElements?.some(bound => detached.has(bound.id) && bound.type === 'arrow') ? newElementWith(element, { boundElements: element.boundElements.filter(bound => !detached.has(bound.id) || bound.type !== 'arrow') }) : element;
  }), files, changed: edits.size > 0, converted, skipped };
}
