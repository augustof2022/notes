import { MAX_INSTRUCTION } from './gemini';

const KEY = 'note-ai-instruction';

/** A ready example the person can fill in and edit. */
export const FEYNMAN_INSTRUCTION = 'Explain like Richard Feynman: plain words, no unexplained jargon. Start with the core idea in one or two sentences, then one picture from everyday life and where that picture breaks, then how it really works. End with one short question I can answer to check that I understood.';

/** The standing instruction sent with every Ask AI question, saved in this browser. */
export function readAiInstruction(): string {
  try { return (localStorage.getItem(KEY) || '').slice(0, MAX_INSTRUCTION); } catch { return ''; }
}

export function saveAiInstruction(text: string) {
  const value = text.trim().slice(0, MAX_INSTRUCTION);
  try { if (value) localStorage.setItem(KEY, value); else localStorage.removeItem(KEY); } catch { /* Ask AI still works without it */ }
}
