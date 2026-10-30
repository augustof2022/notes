export const TEXT_COMMANDS = [
  { id: 'paragraph', label: 'Text', hint: 'Plain paragraph', keywords: 'normal plain paragraph', icon: 'T' },
  { id: 'h1', label: 'Heading 1', hint: '# + Space', keywords: 'h1 title', icon: 'H1' },
  { id: 'h2', label: 'Heading 2', hint: '## + Space', keywords: 'h2 subtitle', icon: 'H2' },
  { id: 'h3', label: 'Heading 3', hint: '### + Space', keywords: 'h3', icon: 'H3' },
  { id: 'bullet', label: 'Bulleted list', hint: '* or - + Space', keywords: 'bullet unordered list', icon: '•' },
  { id: 'number', label: 'Numbered list', hint: '1. + Space', keywords: 'ordered list numbers', icon: '1.' },
  { id: 'check', label: 'Checklist', hint: '[] + Space', keywords: 'todo task check list', icon: '☑' },
  { id: 'bold', label: 'Bold', hint: 'Ctrl+B', keywords: 'strong', icon: 'B' },
  { id: 'italic', label: 'Italic', hint: 'Ctrl+I', keywords: 'emphasis', icon: '𝑖' },
  { id: 'underline', label: 'Underline', hint: 'Ctrl+U', keywords: 'underlined', icon: 'U̲' },
  { id: 'strike', label: 'Strikethrough', hint: 'Cross out text', keywords: 'strike deleted', icon: 'S̶' },
  { id: 'quote', label: 'Quote', hint: '> + Space', keywords: 'blockquote', icon: '❞' },
  { id: 'code', label: 'Code block', hint: '``` + Space', keywords: 'code fence programming', icon: '</>' },
  { id: 'rule', label: 'Divider', hint: 'Horizontal line', keywords: 'separator rule line', icon: '—' },
] as const;
export type TextCommand = typeof TEXT_COMMANDS[number]['id'];
export interface SlashMatch { from: number; to: number; query: string }

/** A slash after whitespace is a command; URL and file-path slashes stay text. */
export function slashMatch(before: string, caret: number, inCode = false): SlashMatch | null {
  if (inCode) return null;
  const match = /(?:^|\s)\/([^/\n]{0,40})$/.exec(before);
  if (!match) return null;
  return { from: caret - match[1].length - 1, to: caret, query: match[1] };
}
export function textCommands(query: string) {
  const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return TEXT_COMMANDS.filter(command => terms.every(term => `${command.label} ${command.keywords}`.toLowerCase().includes(term)));
}
export function textPopupPosition(anchor: { left: number; top: number; bottom: number }, size: { width: number; height: number }, viewport: { width: number; height: number; left?: number; top?: number }, above = false) {
  const left = viewport.left || 0, top = viewport.top || 0, pad = 8;
  const below = anchor.bottom + 6, upper = anchor.top - size.height - 6;
  const y = above && upper >= top + pad ? upper : below + size.height <= top + viewport.height - pad ? below : Math.max(top + pad, upper);
  return { left: Math.max(left + pad, Math.min(anchor.left, left + viewport.width - size.width - pad)), top: y };
}
