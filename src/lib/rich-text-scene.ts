import { convertToExcalidrawElements, mutateElement } from '@excalidraw/excalidraw';
import type { ExcalidrawElement, ExcalidrawTextElement } from '@excalidraw/excalidraw/element/types';
import type { BinaryFileData } from '@excalidraw/excalidraw/types';
import { hasRichFormatting, readRichText, richDocText, safeTextColor, type RichDoc, type RichTextFit } from './rich-text';
import { renderRichText } from './rich-text-render';

export const richRenderId = (id: string) => `note-rich-${id}`;
export const isRichRender = (element: Pick<ExcalidrawElement, 'customData'>) => typeof element.customData?.noteRichTextRender?.ownerId === 'string';
export function selectedText(elements: readonly ExcalidrawElement[], selected: Readonly<Record<string, boolean>>): ExcalidrawTextElement | null {
  const candidates = elements.filter(element => !element.isDeleted && element.type === 'text' && (selected[element.id] || (element.containerId && selected[element.containerId])));
  if (candidates.length !== 1 || candidates[0].locked) return null;
  const text = candidates[0] as ExcalidrawTextElement;
  return elements.some(element => element.id === text.containerId && element.locked) ? null : text;
}

export function richTextWidth(text: ExcalidrawTextElement, elements: readonly ExcalidrawElement[] | ReadonlyMap<string, ExcalidrawElement>) {
  const found = !text.containerId ? undefined : 'get' in elements ? elements.get(text.containerId) : elements.find(element => element.id === text.containerId);
  const container = found && !found.isDeleted ? found : undefined;
  if (container && ['rectangle', 'ellipse', 'diamond'].includes(container.type)) {
    const factor = container.type === 'ellipse' ? Math.SQRT1_2 : container.type === 'diamond' ? 0.5 : 1;
    return Math.max(24, container.width * factor - 10);
  }
  const fit = readRichText(text)?.fit;
  if (fit) return fit.wrap;
  // Small labels can legitimately be narrower than 24px; only a missing or
  // collapsed width falls back to the default wrapping width.
  return text.width >= Math.min(24, text.fontSize) ? text.width : 360;
}

/**
 * Keep a fitted text's wrap width in step with native edits: corner scaling
 * changes its font size proportionally, while a side handle that changes only
 * the width turns it into an ordinary fixed-width text box.
 */
export function syncRichTextFit(text: Pick<ExcalidrawTextElement, 'width' | 'fontSize' | 'containerId'>, fit: RichTextFit | undefined): RichTextFit | undefined {
  if (!fit || text.containerId) return undefined;
  if (Math.abs(text.fontSize - fit.fontSize) > 0.001) {
    const scale = text.fontSize / fit.fontSize;
    return { wrap: Math.max(24, fit.wrap * scale), width: text.width, fontSize: text.fontSize };
  }
  return Math.abs(text.width - fit.width) > 0.5 ? undefined : fit;
}

/** Text remains searchable and bound to its shape; a derived SVG supplies mixed styles. */
export function applyRichText(text: ExcalidrawTextElement, doc: RichDoc, color: string, keepDocument = false, fit?: RichTextFit) {
  const plain = richDocText(doc), rich = hasRichFormatting(doc) || (keepDocument && !!plain.trim()), customData = { ...text.customData };
  if (rich) customData.noteRichText = { version: 1, doc, color: safeTextColor(color) || '#1b1b1f', ...(fit && !text.containerId ? { fit } : {}) };
  else delete customData.noteRichText;
  mutateElement(text, { originalText: plain, text: plain, customData, isDeleted: !plain.trim() && !rich, strokeColor: rich ? 'transparent' : color, autoResize: !rich && !text.containerId }, false);
}

/** Runs in the canvas repair pass, including moves, rotation, resizing, undo, and reload. */
export function repairRichTextElements(input: readonly ExcalidrawElement[], editingId?: string, mutate = mutateElement) {
  const elements = [...input], files: BinaryFileData[] = [], byId = new Map(elements.map(element => [element.id, element]));
  const owners = new Set<string>(); let changed = false;
  // Geometry differing by less than half a pixel is the same layout. The
  // editor centers labels with slightly different math; treating those as
  // changes made both sides correct each other forever.
  const GEOMETRY = new Set(['x', 'y', 'width', 'height']);
  const same = (key: string, current: unknown, next: unknown) => GEOMETRY.has(key) && typeof current === 'number' && typeof next === 'number'
    ? Math.abs(current - next) < 0.5 : JSON.stringify(current) === JSON.stringify(next);
  function update(element: ExcalidrawElement, values: Record<string, any>) {
    if (Object.entries(values).every(([key, value]) => same(key, (element as any)[key], value))) return;
    mutate(element, values, false); changed = true;
  }
  for (const source of [...elements]) {
    if (source.type !== 'text' || source.isDeleted) continue;
    let data = readRichText(source); if (!data) continue;
    if (source.strokeColor !== 'transparent') {
      data = { ...data, color: safeTextColor(source.strokeColor) || data.color };
      update(source, { customData: { ...source.customData, noteRichText: data }, strokeColor: 'transparent' });
    }
    const container = byId.get(source.containerId || '');
    if (container?.isDeleted) { update(source, { isDeleted: true }); continue; }
    const fit = syncRichTextFit(source, data.fit);
    const wrap = fit ? fit.wrap : source.containerId || !data.fit ? richTextWidth(source, byId) : source.width;
    const render = renderRichText(data.doc, { width: wrap, fontSize: source.fontSize, color: data.color, textAlign: source.textAlign, fit: !!fit });
    if (fit || data.fit) {
      const nextFit = fit ? { wrap: fit.wrap, width: render.width, fontSize: source.fontSize } : undefined;
      if (JSON.stringify(nextFit) !== JSON.stringify(data.fit)) {
        const noteRichText: Record<string, unknown> = { ...source.customData?.noteRichText };
        if (nextFit) noteRichText.fit = nextFit; else delete noteRichText.fit;
        update(source, { customData: { ...source.customData, noteRichText } });
      }
    }
    let x = source.x, y = source.y;
    if (container?.type === 'arrow') y += (source.height - render.height) / 2;
    if (container && ['rectangle', 'ellipse', 'diamond'].includes(container.type)) {
      const factor = container.type === 'ellipse' ? Math.SQRT1_2 : container.type === 'diamond' ? 0.5 : 1;
      const required = (render.height + 10) / factor;
      if (container.height < required) update(container, { height: required });
      const left = container.x + (container.width - render.width) / 2, top = container.y + (container.height - container.height * factor) / 2 + 5;
      x = left;
      y = source.verticalAlign === 'top' ? top : source.verticalAlign === 'bottom' ? container.y + container.height - (top - container.y) - render.height : container.y + (container.height - render.height) / 2;
    }
    const angle = container && container.type !== 'arrow' ? container.angle : source.angle;
    // While a label is being edited the editor keeps laying it out itself;
    // leave its box alone until editing ends, then place it once.
    if (source.id === editingId && source.containerId) { x = source.x; y = source.y; update(source, { angle, autoResize: false, strokeColor: 'transparent' }); }
    else update(source, { x, y, width: render.width, height: render.height, angle, autoResize: false, strokeColor: 'transparent' });
    const id = richRenderId(source.id); owners.add(id);
    const attrs = { x, y, width: render.width, height: render.height, angle, opacity: source.id === editingId ? 0 : source.opacity,
      groupIds: source.groupIds, frameId: source.frameId, locked: true, fileId: render.file.id, isDeleted: false,
      customData: { noteRichTextRender: { ownerId: source.id }, ...(source.customData?.noteDiagram ? { noteDiagram: source.customData.noteDiagram } : {}) } };
    const image = byId.get(id);
    if (image?.type === 'image') {
      update(image, attrs);
      // Native grouping moves selected text and shapes together, while its
      // locked SVG preview is not selected. Keep that preview above its owner
      // instead of leaving it behind the newly grouped shape's fill.
      const imageIndex = elements.indexOf(image), sourceIndex = elements.indexOf(source);
      if (imageIndex !== sourceIndex + 1) {
        elements.splice(imageIndex, 1);
        elements.splice(elements.indexOf(source) + 1, 0, image);
        changed = true;
      }
    }
    else {
      const [created] = convertToExcalidrawElements([{ id, type: 'image', ...attrs, status: 'saved', scale: [1, 1] }], { regenerateIds: false });
      elements.splice(elements.findIndex(element => element.id === source.id) + 1, 0, created); changed = true;
    }
    files.push(render.file);
  }
  // Duplicated images still refer to the old owner; regenerate them from the
  // duplicated text instead. Undoing formatting also removes its old render.
  for (const element of elements) if (isRichRender(element) && !element.isDeleted && !owners.has(element.id)) update(element, { isDeleted: true });
  return { elements, files, changed };
}

/** The hidden editing preview is transient; saved boards always show their text. */
export function richTextForStorage(elements: readonly ExcalidrawElement[]): ExcalidrawElement[] {
  const byId = new Map(elements.map(element => [element.id, element]));
  return elements.map(element => {
    const owner = element.customData?.noteRichTextRender?.ownerId;
    return owner && byId.has(owner) ? { ...element, opacity: byId.get(owner)!.opacity } : element;
  });
}
