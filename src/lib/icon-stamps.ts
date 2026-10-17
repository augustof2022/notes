import {
  CircleHelp, CircleAlert, Search, Star, Lightbulb, Check, ListTodo, Clock, Bookmark,
  Flag, TriangleAlert, MessageCircle, BookOpen, Link, Target, Pin, CalendarClock,
  CircleX, CircleCheck, Pause, Ban, Bug, Wrench, Code, Calculator, FlaskConical,
  GraduationCap, Quote, Paperclip, Heart, ThumbsUp, ArrowRightLeft, Eye, Repeat,
  type LucideIcon,
} from 'lucide-react';

export interface StampIcon { id: string; name: string; meaning: string; keywords: string; icon: LucideIcon }
export const STAMP_ICONS: readonly StampIcon[] = [
  { id: 'clarify', name: 'Clarify', meaning: 'Need to clarify or check', keywords: '? question help unsure doubt verify', icon: CircleHelp },
  { id: 'remember', name: 'Remember', meaning: 'Need to remember', keywords: '! important memorize reminder', icon: CircleAlert },
  { id: 'research', name: 'Research', meaning: 'Look this up', keywords: 'search magnifying glass investigate find', icon: Search },
  { id: 'important', name: 'Important', meaning: 'A key point', keywords: 'star favorite priority', icon: Star },
  { id: 'idea', name: 'Idea', meaning: 'An idea to explore', keywords: 'light bulb inspiration brainstorm', icon: Lightbulb },
  { id: 'done', name: 'Done', meaning: 'Completed', keywords: 'check tick finished task', icon: Check },
  { id: 'todo', name: 'To do', meaning: 'An action to take', keywords: 'task list checklist pending', icon: ListTodo },
  { id: 'later', name: 'Later', meaning: 'Come back to this', keywords: 'clock time revisit defer', icon: Clock },
  { id: 'bookmark', name: 'Bookmark', meaning: 'Save for reference', keywords: 'mark reference read save', icon: Bookmark },
  { id: 'flag', name: 'Follow up', meaning: 'Needs a follow-up', keywords: 'flag attention followup', icon: Flag },
  { id: 'warning', name: 'Warning', meaning: 'Watch out for this', keywords: 'caution alert danger risk', icon: TriangleAlert },
  { id: 'discuss', name: 'Discuss', meaning: 'Ask or discuss with someone', keywords: 'chat conversation talk message', icon: MessageCircle },
  { id: 'read', name: 'Read', meaning: 'Reading or reference material', keywords: 'book source article study', icon: BookOpen },
  { id: 'related', name: 'Related', meaning: 'Connect with another idea', keywords: 'link connection relationship url', icon: Link },
  { id: 'goal', name: 'Goal', meaning: 'An objective to reach', keywords: 'target aim focus outcome', icon: Target },
  { id: 'pin', name: 'Pin', meaning: 'Keep this in view', keywords: 'pinned key highlight', icon: Pin },
  { id: 'deadline', name: 'Deadline', meaning: 'A date or deadline', keywords: 'calendar schedule due event', icon: CalendarClock },
  { id: 'incorrect', name: 'Incorrect', meaning: 'Wrong or needs correction', keywords: 'x false mistake reject error', icon: CircleX },
  { id: 'verified', name: 'Verified', meaning: 'Checked and confirmed', keywords: 'correct true approved valid check', icon: CircleCheck },
  { id: 'pause', name: 'On hold', meaning: 'Pause for now', keywords: 'wait pending hold stopped', icon: Pause },
  { id: 'blocked', name: 'Blocked', meaning: 'Cannot proceed yet', keywords: 'stop ban obstacle blocker', icon: Ban },
  { id: 'bug', name: 'Bug', meaning: 'A problem to investigate', keywords: 'issue defect error debug', icon: Bug },
  { id: 'fix', name: 'Fix', meaning: 'Needs a fix or adjustment', keywords: 'wrench repair improve change', icon: Wrench },
  { id: 'code', name: 'Code', meaning: 'Code or a technical example', keywords: 'programming syntax snippet development', icon: Code },
  { id: 'calculate', name: 'Calculate', meaning: 'Work out the numbers', keywords: 'math formula calculator equation compute', icon: Calculator },
  { id: 'experiment', name: 'Experiment', meaning: 'Test an assumption', keywords: 'flask science lab try hypothesis', icon: FlaskConical },
  { id: 'learn', name: 'Learn', meaning: 'Study or practice this', keywords: 'education graduation exam lesson', icon: GraduationCap },
  { id: 'quote', name: 'Quote', meaning: 'A quotation or definition', keywords: 'cite citation definition words', icon: Quote },
  { id: 'attachment', name: 'Attachment', meaning: 'Related supporting material', keywords: 'paperclip file document evidence', icon: Paperclip },
  { id: 'favorite', name: 'Favorite', meaning: 'Something you like', keywords: 'heart love personal', icon: Heart },
  { id: 'approve', name: 'Approve', meaning: 'A good option', keywords: 'thumbs up agree recommendation', icon: ThumbsUp },
  { id: 'compare', name: 'Compare', meaning: 'Compare these ideas', keywords: 'difference versus vs alternative arrows', icon: ArrowRightLeft },
  { id: 'review', name: 'Review', meaning: 'Take another look', keywords: 'eye inspect check observe', icon: Eye },
  { id: 'repeat', name: 'Practice', meaning: 'Repeat or practice', keywords: 'revision rehearse repeat refresh', icon: Repeat },
];

export const STAMP_COLORS = ['#7c3aed', '#dc2626', '#d97706', '#15803d', '#2563eb', '#202124'] as const;
export interface StampPreferences { iconId: string; color: string; size: number; repeat: boolean }
export const DEFAULT_STAMP: StampPreferences = { iconId: 'clarify', color: STAMP_COLORS[0], size: 48, repeat: false };
const STORAGE_KEY = 'note-icon-stamp';
export const ICON_STAMP_FILE_PREFIX = 'note-icon-v1-';
export function isIconStampFile(id: string) { return id.startsWith(ICON_STAMP_FILE_PREFIX); }
export function stampIcon(id: string): StampIcon { return STAMP_ICONS.find(icon => icon.id === id) || STAMP_ICONS[0]; }
export function filterStampIcons(query: string): readonly StampIcon[] {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return STAMP_ICONS.filter(icon => words.every(word => `${icon.name} ${icon.meaning} ${icon.keywords}`.toLowerCase().includes(word)));
}
export function readStampPreferences(): StampPreferences {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
    if (!saved || typeof saved !== 'object') return { ...DEFAULT_STAMP };
    return {
      iconId: stampIcon(saved.iconId).id,
      color: typeof saved.color === 'string' && /^#[0-9a-f]{6}$/i.test(saved.color) ? saved.color : DEFAULT_STAMP.color,
      size: typeof saved.size === 'number' && Number.isFinite(saved.size) ? Math.max(24, Math.min(160, saved.size)) : DEFAULT_STAMP.size,
      repeat: saved.repeat === true,
    };
  } catch { return { ...DEFAULT_STAMP }; }
}
export function saveStampPreferences(value: StampPreferences) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(value)); } catch { /* Stamping also works without browser storage. */ }
}
export function isStampShortcut(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'repeat' | 'isComposing' | 'defaultPrevented'>): boolean {
  return event.key.toLowerCase() === 'i' && !event.ctrlKey && !event.metaKey && !event.altKey && !event.repeat && !event.isComposing && !event.defaultPrevented;
}
export function stampPosition(client: { x: number; y: number }, state: { offsetLeft: number; offsetTop: number; scrollX: number; scrollY: number; zoom: { value: number } }, size: number) {
  return { x: (client.x - state.offsetLeft) / state.zoom.value - state.scrollX - size / 2,
    y: (client.y - state.offsetTop) / state.zoom.value - state.scrollY - size / 2 };
}
