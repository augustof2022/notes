import { STAMP_ICONS as LEGACY_STAMP_ICONS } from './icon-stamps';
/** Authored 24-unit vectors: the same geometry powers the picker and native board objects. */
export type StampPoint = readonly [number, number];
export type StampGeometry =
  | { readonly type: 'line'; readonly points: readonly StampPoint[] }
  | { readonly type: 'ellipse'; readonly x: number; readonly y: number; readonly width: number; readonly height: number };
export type StampCategory = 'Attention' | 'Progress' | 'People' | 'Reference';
export interface StampIcon {
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly category: StampCategory;
  readonly defaultColor: string;
  readonly geometry: readonly StampGeometry[];
}

const line = (...points: StampPoint[]): StampGeometry => ({ type: 'line', points });
const ellipse = (x: number, y: number, width: number, height = width): StampGeometry => ({ type: 'ellipse', x, y, width, height });
const dot = (x: number, y: number): StampGeometry => ellipse(x - 0.3, y - 0.3, 0.6);
const box = (x: number, y: number, width: number, height: number): StampGeometry => line([x, y], [x + width, y], [x + width, y + height], [x, y + height], [x, y]);
const arc = (cx: number, cy: number, radius: number, start: number, end: number, steps = 14): StampPoint[] =>
  Array.from({ length: steps + 1 }, (_, index) => {
    const angle = start + (end - start) * index / steps;
    return [cx + radius * Math.cos(angle), cy + radius * Math.sin(angle)] as const;
  });
function curve(a: StampPoint, b: StampPoint, c: StampPoint, d: StampPoint, steps = 12): StampPoint[] {
  return Array.from({ length: steps + 1 }, (_, index) => {
    const t = index / steps, u = 1 - t;
    return [u ** 3 * a[0] + 3 * u * u * t * b[0] + 3 * u * t * t * c[0] + t ** 3 * d[0],
      u ** 3 * a[1] + 3 * u * u * t * b[1] + 3 * u * t * t * c[1] + t ** 3 * d[1]] as const;
  });
}
const question = [line(...curve([7.5, 7], [7.5, 1.5], [18.5, 1.5], [17, 8]), ...curve([17, 8], [16.5, 10], [12, 10], [12, 14]).slice(1)), dot(12, 18.5)];
const check = line([5, 12], [9.5, 16.5], [19, 6.5]);
const clock = [ellipse(3, 3, 18), line([12, 6.5], [12, 12], [16, 14.5])];
const bulb = [line(...arc(12, 9, 6.5, Math.PI * 0.8, Math.PI * 2.2, 22), [15.5, 17], [8.5, 17], [6.74, 12.82]), line([9, 20], [15, 20]), line([10.5, 22], [13.5, 22])];
const book = [line([12, 6], [9, 4], [3, 4], [3, 19], [9, 19], [12, 21], [15, 19], [21, 19], [21, 4], [15, 4], [12, 6], [12, 21])];

export const STAMP_CATEGORIES: readonly StampCategory[] = ['Attention', 'Progress', 'People', 'Reference'];

export const STAMP_ICONS: readonly StampIcon[] = [
  { id: 'clarify', label: 'Clarify', description: 'A question to clarify or check', category: 'Attention', defaultColor: '#9c36b5', geometry: question },
  { id: 'remember', label: 'Remember', description: 'Something important to remember', category: 'Attention', defaultColor: '#e8590c', geometry: [line([12, 3], [12, 14]), dot(12, 20)] },
  { id: 'research', label: 'Research', description: 'Investigate or find more information', category: 'Attention', defaultColor: '#1971c2', geometry: [ellipse(3, 3, 13), line([14.5, 14.5], [21, 21])] },
  { id: 'idea', label: 'Idea', description: 'An idea or possible solution', category: 'Attention', defaultColor: '#e67700', geometry: bulb },
  { id: 'warning', label: 'Warning', description: 'A risk or caution to consider', category: 'Attention', defaultColor: '#e8590c', geometry: [line([12, 2], [22, 21], [2, 21], [12, 2]), line([12, 9], [12, 14]), dot(12, 18)] },
  { id: 'priority', label: 'Priority', description: 'A flagged priority', category: 'Attention', defaultColor: '#e03131', geometry: [line([5, 22], [5, 3], [13, 3], [15, 5], [21, 5], [21, 15], [13, 15], [11, 13], [5, 13])] },
  { id: 'star', label: 'Highlight', description: 'A standout detail or key point', category: 'Attention', defaultColor: '#e67700', geometry: [line([12, 2], [15.1, 8.3], [22, 9.3], [17, 14.2], [18.2, 21], [12, 17.8], [5.8, 21], [7, 14.2], [2, 9.3], [8.9, 8.3], [12, 2])] },
  { id: 'bug', label: 'Bug', description: 'A defect or issue to fix', category: 'Attention', defaultColor: '#e03131', geometry: [ellipse(7, 7, 10, 14), line([9, 7], [9, 4], [15, 4], [15, 7]), line([8, 4], [6, 2]), line([16, 4], [18, 2]), line([7, 10], [3, 8]), line([7, 14], [2, 14]), line([7, 18], [3, 21]), line([17, 10], [21, 8]), line([17, 14], [22, 14]), line([17, 18], [21, 21]), line([12, 8], [12, 21])] },
  { id: 'todo', label: 'To do', description: 'Work that still needs doing', category: 'Progress', defaultColor: '#495057', geometry: [box(3, 3, 18, 18), line([7, 8], [17, 8]), line([7, 12], [17, 12]), line([7, 16], [13, 16])] },
  { id: 'done', label: 'Done', description: 'Finished, confirmed, or approved', category: 'Progress', defaultColor: '#2b8a3e', geometry: [ellipse(2, 2, 20), check] },
  { id: 'clock', label: 'Waiting', description: 'Waiting for time or a response', category: 'Progress', defaultColor: '#1971c2', geometry: clock },
  { id: 'deadline', label: 'Deadline', description: 'A due date or time-sensitive task', category: 'Progress', defaultColor: '#e03131', geometry: [box(3, 5, 18, 16), line([7, 2], [7, 8]), line([17, 2], [17, 8]), line([3, 10], [21, 10]), line([12, 13], [12, 16]), dot(12, 19)] },
  { id: 'decision', label: 'Decision', description: 'A choice or decision point', category: 'Progress', defaultColor: '#9c36b5', geometry: [line([12, 2], [22, 12], [12, 22], [2, 12], [12, 2]), line([7, 12], [10.5, 15.5], [17, 8.5])] },
  { id: 'target', label: 'Goal', description: 'A goal or desired outcome', category: 'Progress', defaultColor: '#1971c2', geometry: [ellipse(2, 2, 20), ellipse(6, 6, 12), ellipse(10, 10, 4)] },
  { id: 'milestone', label: 'Milestone', description: 'A key checkpoint or achievement', category: 'Progress', defaultColor: '#2b8a3e', geometry: [line([3, 21], [3, 3], [20, 3], [20, 14], [3, 14]), line([7, 3], [7, 7], [11, 7], [11, 11], [15, 11], [15, 14]), line([11, 3], [11, 7], [15, 7], [15, 3]), line([15, 7], [20, 7]), line([7, 11], [7, 14])] },
  { id: 'follow-up', label: 'Follow up', description: 'Return to this or ask for an update', category: 'Progress', defaultColor: '#1971c2', geometry: [line(...arc(12, 12, 8, Math.PI * 0.2, Math.PI * 1.8, 22)), line([14.5, 3.5], [18.5, 7.3], [21.5, 3]), line([12, 7], [12, 12], [8, 14])] },
  { id: 'pause', label: 'On hold', description: 'Paused until something changes', category: 'Progress', defaultColor: '#e67700', geometry: [ellipse(2, 2, 20), line([9, 7], [9, 17]), line([15, 7], [15, 17])] },
  { id: 'blocked', label: 'Blocked', description: 'Something is preventing progress', category: 'Progress', defaultColor: '#e03131', geometry: [ellipse(2, 2, 20), line([5, 19], [19, 5])] },
  { id: 'person', label: 'Owner', description: 'An owner or person responsible', category: 'People', defaultColor: '#1971c2', geometry: [ellipse(8, 2, 8), line(...curve([3, 22], [3, 9], [21, 9], [21, 22]))] },
  { id: 'team', label: 'Team', description: 'A team or shared responsibility', category: 'People', defaultColor: '#1971c2', geometry: [ellipse(8, 3, 8), ellipse(2, 6, 5), ellipse(17, 6, 5), line(...curve([5, 22], [5, 10], [19, 10], [19, 22])), line(...curve([2, 20], [0.5, 15], [2, 12], [6, 13])), line(...curve([22, 20], [23.5, 15], [22, 12], [18, 13]))] },
  { id: 'discussion', label: 'Discuss', description: 'Talk this through with someone', category: 'People', defaultColor: '#9c36b5', geometry: [line([3, 3], [21, 3], [21, 16], [12, 16], [6, 21], [6, 16], [3, 16], [3, 3]), line([7, 8], [17, 8]), line([7, 12], [14, 12])] },
  { id: 'ask', label: 'Ask someone', description: 'A question for a conversation', category: 'People', defaultColor: '#9c36b5', geometry: [line([2, 2], [22, 2], [22, 18], [13, 18], [7, 22], [7, 18], [2, 18], [2, 2]), line(...curve([8.5, 7], [8.5, 2.5], [18, 5], [13, 9]), [12, 11]), dot(12, 14)] },
  { id: 'heart', label: 'Like', description: 'Something valuable or appreciated', category: 'People', defaultColor: '#c2255c', geometry: [line(...curve([12, 21], [9, 18], [2, 13], [2, 8]), ...curve([2, 8], [2, 1], [10, 1], [12, 6]).slice(1), ...curve([12, 6], [14, 1], [22, 1], [22, 8]).slice(1), ...curve([22, 8], [22, 13], [15, 18], [12, 21]).slice(1))] },
  { id: 'handoff', label: 'Hand off', description: 'Pass this to another person or team', category: 'People', defaultColor: '#1971c2', geometry: [ellipse(3, 3, 6), ellipse(15, 3, 6), line(...curve([2, 21], [2, 11], [10, 11], [10, 21])), line(...curve([14, 21], [14, 11], [22, 11], [22, 21])), line([9, 11], [15, 11]), line([12.5, 8.5], [15, 11], [12.5, 13.5])] },
  { id: 'bookmark', label: 'Bookmark', description: 'Save this for later', category: 'Reference', defaultColor: '#9c36b5', geometry: [line([6, 2], [18, 2], [18, 22], [12, 17], [6, 22], [6, 2])] },
  { id: 'pin', label: 'Pin', description: 'Keep this point in view', category: 'Reference', defaultColor: '#e03131', geometry: [line([8, 2], [16, 2], [15, 10], [19, 14], [5, 14], [9, 10], [8, 2]), line([12, 14], [12, 22])] },
  { id: 'link', label: 'Link', description: 'A related item or connection', category: 'Reference', defaultColor: '#1971c2', geometry: [line(...curve([9, 8], [14, 2], [22, 1], [22, 8]), ...curve([22, 8], [22, 11], [19, 13], [16, 15]).slice(1)), line(...curve([15, 16], [10, 22], [2, 23], [2, 16]), ...curve([2, 16], [2, 13], [5, 11], [8, 9]).slice(1)), line([8, 16], [16, 8])] },
  { id: 'note', label: 'Note', description: 'Additional context or an annotation', category: 'Reference', defaultColor: '#495057', geometry: [line([4, 2], [15, 2], [21, 8], [21, 22], [4, 22], [4, 2]), line([15, 2], [15, 8], [21, 8]), line([8, 12], [17, 12]), line([8, 16], [17, 16])] },
  { id: 'reference', label: 'Reference', description: 'A source, book, or reference to consult', category: 'Reference', defaultColor: '#1971c2', geometry: book },
  { id: 'attachment', label: 'Attachment', description: 'A file or supporting material', category: 'Reference', defaultColor: '#495057', geometry: [line(...curve([9, 8], [17, -1], [25, 5], [17, 13]), [10, 20], ...curve([10, 20], [4, 26], [-1, 18], [5, 12]).slice(1), [13, 4]), line(...curve([13, 4], [16, 1], [20, 5], [17, 8]), [9, 16], ...curve([9, 16], [7, 18], [5, 15], [7, 13]).slice(1), [14, 6])] },
  { id: 'code', label: 'Code', description: 'Code or a technical detail', category: 'Reference', defaultColor: '#1971c2', geometry: [line([7, 6], [2, 12], [7, 18]), line([17, 6], [22, 12], [17, 18]), line([14, 3], [10, 21])] },
  { id: 'experiment', label: 'Experiment', description: 'Test an assumption or try something', category: 'Reference', defaultColor: '#2b8a3e', geometry: [line([8, 2], [16, 2]), line([9, 2], [9, 10], [3, 20], [4, 22], [20, 22], [21, 20], [15, 10], [15, 2]), line([6, 15], [18, 15]), dot(10, 19), dot(14, 17.5)] },
  { id: 'money', label: 'Cost', description: 'A cost, budget, or financial impact', category: 'Reference', defaultColor: '#2b8a3e', geometry: [ellipse(2, 2, 20), line([12, 5], [12, 19]), line(...curve([16, 8], [7, 3], [5, 12], [12, 12]), ...curve([12, 12], [20, 12], [17, 22], [7, 16]).slice(1))] },
  { id: 'lock', label: 'Private', description: 'Private or access-restricted information', category: 'Reference', defaultColor: '#495057', geometry: [box(4, 10, 16, 12), line([7, 10], [7, 7], ...arc(12, 7, 5, Math.PI, Math.PI * 2, 12).slice(1), [17, 10]), line([12, 14], [12, 18])] },
  { id: 'shield', label: 'Security', description: 'A security or trust consideration', category: 'Reference', defaultColor: '#2b8a3e', geometry: [line([12, 2], [21, 6], [21, 12], ...curve([21, 12], [21, 18], [15, 21], [12, 22]).slice(1), ...curve([12, 22], [9, 21], [3, 18], [3, 12]).slice(1), [3, 6], [12, 2]), line([7, 12], [10, 15], [17, 8])] },
  { id: 'location', label: 'Location', description: 'A place, site, or meeting location', category: 'Reference', defaultColor: '#e03131', geometry: [line(...curve([12, 22], [-3, 7], [6, -1], [12, 2]), ...curve([12, 2], [18, -1], [27, 7], [12, 22]).slice(1)), ellipse(9, 6, 6)] },
  { id: 'calendar', label: 'Schedule', description: 'A date, meeting, or planned event', category: 'Reference', defaultColor: '#1971c2', geometry: [box(3, 5, 18, 17), line([7, 2], [7, 8]), line([17, 2], [17, 8]), line([3, 10], [21, 10]), line([7, 14], [9, 14]), line([13, 14], [17, 14]), line([7, 18], [11, 18])] },
  { id: 'document-check', label: 'Review', description: 'Review or validate this information', category: 'Progress', defaultColor: '#1971c2', geometry: [line([4, 2], [15, 2], [20, 7], [20, 22], [4, 22], [4, 2]), line([15, 2], [15, 7], [20, 7]), line([7, 14], [10, 17], [17, 10])] },
  { id: 'lightning', label: 'Quick win', description: 'A quick action or opportunity', category: 'Attention', defaultColor: '#e67700', geometry: [line([14, 2], [4, 14], [11, 14], [10, 22], [21, 9], [13, 9], [14, 2])] },
  { id: 'dependency', label: 'Dependency', description: 'This depends on another item', category: 'Progress', defaultColor: '#9c36b5', geometry: [box(2, 2, 7, 7), box(15, 15, 7, 7), line([9, 5.5], [18.5, 5.5], [18.5, 12]), line([15.5, 9], [18.5, 12], [21.5, 9])] },
  { id: 'incorrect', label: 'Incorrect', description: 'Wrong or in need of correction', category: 'Attention', defaultColor: '#e03131', geometry: [ellipse(2, 2, 20), line([8, 8], [16, 16]), line([16, 8], [8, 16])] },
  { id: 'fix', label: 'Fix', description: 'A repair or adjustment is needed', category: 'Progress', defaultColor: '#e67700', geometry: [line([15, 3], [14, 8], [17, 11], [22, 10], [21, 15], [16, 17], [12, 15], [5, 22], [2, 19], [9, 12], [7, 8], [9, 3], [15, 3])] },
  { id: 'calculate', label: 'Calculate', description: 'Work out a number or formula', category: 'Reference', defaultColor: '#1971c2', geometry: [box(4, 2, 16, 20), box(7, 5, 10, 4), line([7, 13], [9, 13]), line([15, 13], [17, 13]), line([7, 18], [9, 18]), line([15, 18], [17, 18])] },
  { id: 'learn', label: 'Learn', description: 'Something to study or practice', category: 'Reference', defaultColor: '#1971c2', geometry: [line([2, 8], [12, 3], [22, 8], [12, 13], [2, 8]), line([6, 11], [6, 17], [12, 20], [18, 17], [18, 11]), line([22, 8], [22, 18])] },
  { id: 'quote', label: 'Quote', description: 'A quotation or definition to cite', category: 'Reference', defaultColor: '#9c36b5', geometry: [line([3, 4], [10, 4], [10, 13], [5, 20], [2, 18], [6, 12], [3, 12], [3, 4]), line([14, 4], [21, 4], [21, 13], [16, 20], [13, 18], [17, 12], [14, 12], [14, 4])] },
  { id: 'approve', label: 'Approve', description: 'A good option or recommendation', category: 'People', defaultColor: '#2b8a3e', geometry: [box(2, 10, 4, 12), line([6, 10], [11, 2], [14, 2], [14, 10], [21, 10], [22, 13], [19, 22], [6, 22])] },
  { id: 'compare', label: 'Compare', description: 'Compare two ideas or alternatives', category: 'Reference', defaultColor: '#1971c2', geometry: [line([3, 7], [21, 7]), line([17, 3], [21, 7], [17, 11]), line([21, 17], [3, 17]), line([7, 13], [3, 17], [7, 21])] },
  { id: 'repeat', label: 'Practice', description: 'Repeat, rehearse, or revise this', category: 'Progress', defaultColor: '#1971c2', geometry: [line([3, 9], [6, 5], [18, 5], [21, 9]), line([17, 9], [21, 9], [21, 3]), line([21, 15], [18, 19], [6, 19], [3, 15]), line([7, 15], [3, 15], [3, 21])] },
];

// Keep choices saved by earlier image-stamp releases when creating new vectors.
const LEGACY_ICONS: Record<string, string> = { important: 'star', later: 'clock', flag: 'follow-up', discuss: 'discussion', read: 'reference', related: 'link', goal: 'target', verified: 'done', favorite: 'heart', review: 'document-check' };
export function getStampIcon(id: string): StampIcon {
  return STAMP_ICONS.find(icon => icon.id === (LEGACY_ICONS[id] || id)) ?? STAMP_ICONS[0];
}
export function filterVectorStampIcons(query: string, category = 'all'): readonly StampIcon[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return STAMP_ICONS.filter(icon => {
    if (category !== 'all' && icon.category !== category) return false;
    const legacy = LEGACY_STAMP_ICONS.filter(item => getStampIcon(item.id).id === icon.id).map(item => `${item.name} ${item.meaning} ${item.keywords}`).join(' ');
    const text = `${icon.label} ${icon.description} ${icon.category} ${legacy}`.toLowerCase();
    return words.every(word => text.includes(word));
  });
}

export interface StampPreferences { iconId: string; color: string; size: number; repeat: boolean }
export const STAMP_STORAGE_KEY = 'note-icon-stamp';
export const DEFAULT_STAMP_PREFERENCES: Readonly<StampPreferences> = { iconId: 'clarify', color: '#9c36b5', size: 48, repeat: true };

export function normalizeStampPreferences(value: unknown): StampPreferences {
  const source = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const icon = getStampIcon(typeof source.iconId === 'string' ? source.iconId : 'clarify');
  const color = typeof source.color === 'string' && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(source.color) ? source.color : icon.defaultColor;
  const size = typeof source.size === 'number' && Number.isFinite(source.size) ? Math.min(160, Math.max(24, source.size)) : 48;
  return { iconId: icon.id, color, size, repeat: typeof source.repeat === 'boolean' ? source.repeat : true };
}

export function readStampPreferences(): StampPreferences {
  try { return normalizeStampPreferences(JSON.parse(localStorage.getItem(STAMP_STORAGE_KEY) || '{}')); }
  catch { return { ...DEFAULT_STAMP_PREFERENCES }; }
}

export function storeStampPreferences(preferences: StampPreferences): void {
  try { localStorage.setItem(STAMP_STORAGE_KEY, JSON.stringify(normalizeStampPreferences(preferences))); }
  catch { /* Stamping remains available without browser storage. */ }
}

export interface IconStampData { id: string; iconId: string; label: string }
export function readIconStampData(element: { customData?: Record<string, unknown> | null }): IconStampData | null {
  const data = element.customData?.noteIconStamp;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const stamp = data as Record<string, unknown>;
  return typeof stamp.id === 'string' && !!stamp.id && typeof stamp.iconId === 'string' && STAMP_ICONS.some(icon => icon.id === stamp.iconId)
    && typeof stamp.label === 'string' && !!stamp.label ? stamp as unknown as IconStampData : null;
}
