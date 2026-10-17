import { renderToStaticMarkup } from 'react-dom/server';
import { convertToExcalidrawElements } from '@excalidraw/excalidraw';
import type { BinaryFileData } from '@excalidraw/excalidraw/types';
import { ICON_STAMP_FILE_PREFIX, stampIcon, type StampPreferences } from './icon-stamps';

export function createIconStamp(preferences: StampPreferences, position: { x: number; y: number }) {
  const icon = stampIcon(preferences.iconId), Icon = icon.icon;
  const svg = renderToStaticMarkup(<Icon xmlns="http://www.w3.org/2000/svg" size={512} color={preferences.color} strokeWidth={2} />);
  const fileId = `${ICON_STAMP_FILE_PREFIX}${icon.id}-${preferences.color.slice(1).toLowerCase()}` as BinaryFileData['id'];
  const file = { id: fileId, dataURL: `data:image/svg+xml;base64,${btoa(svg)}`, mimeType: 'image/svg+xml', created: Date.now() } as BinaryFileData;
  const [element] = convertToExcalidrawElements([{ type: 'image', ...position, width: preferences.size, height: preferences.size,
    fileId, status: 'saved', scale: [1, 1], customData: { noteIconStamp: { iconId: icon.id, name: icon.name, meaning: icon.meaning, color: preferences.color } } }]);
  return { file, element };
}
