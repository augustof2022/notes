/** Tried in order: a model with no free allowance for this key falls through to the next. */
export const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'];
export const GEMINI_MODEL = GEMINI_MODELS[0];
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface AskImage { mimeType: string; data: string }
/** 'ask' is an ordinary question; 'term' explains a clicked term inside its thread, fast and without search. */
export type AskMode = 'ask' | 'term';
export interface AskRequest { question: string; context: string[]; images: AskImage[]; instruction?: string; mode?: AskMode }
export interface AskAnswer { text: string; sources: { title: string; url: string }[]; searched: boolean; model?: string }

export type QuotaWindow = 'minute' | 'day' | 'none' | 'unknown';
export class GeminiError extends Error {
  constructor(message: string, readonly kind: 'key' | 'quota' | 'unavailable' | 'blocked' | 'network' | 'other', readonly detail = '', readonly quota: QuotaWindow = 'unknown', readonly retrySeconds = 0) { super(message); }
}

const SYSTEM = 'You answer questions written on a personal note board. Reply concisely in Markdown: a direct answer first, then short bullet points only if they help. No preamble. Use the attached notes and images as context when the question refers to "this" or "that".';

/** Every answer marks its key terms so the Learn panel can turn them into clickable threads. */
const TERMS = 'Mark 3 to 6 key terms a learner may not know by wrapping each in [[double brackets]] the first time it appears, for example [[photosynthesis]]. Bracket single words or short phrases only.';
const TERM_MODE = 'The person clicked a term to learn it. Explain it as it is used in the topic given in the notes: what it means here, in plain words, in a few short lines. Then add one line that starts with "Origin:" and gives its real etymology. If you do not know a real etymology, write instead one line that starts with "Memory hook (made up):" and gives a short invented story that anchors the meaning; never present a made-up origin as real.';
export const MAX_INSTRUCTION = 2000;

export function systemText(request: Pick<AskRequest, 'instruction' | 'mode'>) {
  const own = (request.instruction || '').trim().slice(0, MAX_INSTRUCTION);
  return [SYSTEM, TERMS, request.mode === 'term' ? TERM_MODE : '', own ? `The person's standing instruction for every answer (follow it unless it conflicts with the rules above):\n${own}` : '']
    .filter(Boolean).join('\n\n');
}

/**
 * Thinking makes Gemini slower before the first word. Gemini 2.5 Flash turns
 * it off with a zero budget (2.5 Flash-Lite does not think by default); newer
 * models take a thinking level, minimal for term look-ups and low otherwise.
 * See https://ai.google.dev/gemini-api/docs/thinking.
 */
type Thinking = Record<string, string | number> | undefined;

/**
 * Thinking settings to try in order: the fastest first, then a setting more
 * models accept (some newer models do not offer minimal), then none.
 */
export function thinkingConfigs(model: string, fast: boolean): Thinking[] {
  if (/2\.5-flash-lite/.test(model) || /2\.5-pro/.test(model)) return [undefined];
  if (/2\.5-flash/.test(model)) return fast ? [{ thinkingBudget: 0 }, undefined] : [undefined];
  return fast ? [{ thinkingLevel: 'minimal' }, { thinkingLevel: 'low' }, undefined] : [{ thinkingLevel: 'low' }, undefined];
}
export const thinkingConfig = (model: string, fast: boolean) => thinkingConfigs(model, fast)[0];

/** The setting each model accepted in this session, so a rejected one is not sent again. */
const acceptedThinking = new Map<string, number>();
export const forgetThinking = () => acceptedThinking.clear();

export function geminiBody(request: AskRequest, search: boolean, model = '', step = 0) {
  const notes = request.context.filter(text => text.trim()).map(text => `Note on the board:\n${text.trim()}`);
  const config = thinkingConfigs(model, request.mode === 'term')[step];
  return {
    systemInstruction: { parts: [{ text: systemText(request) }] },
    contents: [{ role: 'user', parts: [
      ...request.images.map(image => ({ inline_data: { mime_type: image.mimeType, data: image.data } })),
      ...notes.map(text => ({ text })),
      { text: request.question.trim() },
    ] }],
    ...(search ? { tools: [{ google_search: {} }] } : {}),
    ...(config ? { generationConfig: { thinkingConfig: config } } : {}),
  };
}

/**
 * Merge server-sent stream chunks into one response shaped like
 * generateContent's, so the same reader and errors apply. Thought parts are
 * skipped; grounding sources may arrive in any chunk.
 */
export function mergeStreamChunks(chunks: any[]) {
  let text = '', finishReason: string | undefined, promptFeedback: any;
  const groundingChunks: any[] = [];
  for (const chunk of chunks) {
    if (chunk?.error) throw failure(Number(chunk.error.code) || 500, chunk);
    const candidate = chunk?.candidates?.[0];
    for (const part of candidate?.content?.parts || []) if (typeof part?.text === 'string' && !part.thought) text += part.text;
    groundingChunks.push(...(candidate?.groundingMetadata?.groundingChunks || []));
    finishReason = candidate?.finishReason || finishReason;
    promptFeedback = chunk?.promptFeedback || promptFeedback;
  }
  return { candidates: [{ content: { parts: text ? [{ text }] : [] }, groundingMetadata: { groundingChunks }, finishReason }], promptFeedback };
}

/** Parse `data: {...}` lines; returns the parsed chunks and any unfinished line. */
export function sseChunks(buffer: string): { chunks: any[]; rest: string } {
  const lines = buffer.split(/\r?\n/), rest = lines.pop() || '', chunks: any[] = [];
  for (const line of lines) {
    if (!line.startsWith('data:')) continue;
    try { chunks.push(JSON.parse(line.slice(5).trim())); } catch { /* keep-alive or partial line */ }
  }
  return { chunks, rest };
}

async function readStream(response: Response, onText: (text: string) => void) {
  const chunks: any[] = [];
  const take = (found: any[]) => { if (!found.length) return; chunks.push(...found); const merged = mergeStreamChunks(chunks); onText(merged.candidates[0].content.parts[0]?.text || ''); };
  if (!response.body) { take(sseChunks(`${await response.text()}\n`).chunks); return mergeStreamChunks(chunks); }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    const parsed = sseChunks(done ? `${buffer}\n` : buffer); buffer = parsed.rest; take(parsed.chunks);
    if (done) break;
  }
  return mergeStreamChunks(chunks);
}

export function readGeminiAnswer(json: any, searched: boolean): AskAnswer {
  const candidate = json?.candidates?.[0];
  const text = (candidate?.content?.parts || []).map((part: any) => typeof part?.text === 'string' ? part.text : '').join('').trim();
  if (!text) {
    const reason = json?.promptFeedback?.blockReason || candidate?.finishReason;
    throw new GeminiError(reason && reason !== 'STOP' ? `Gemini did not answer (${String(reason).toLowerCase().replace(/_/g, ' ')}).` : 'Gemini returned an empty answer.', reason ? 'blocked' : 'other');
  }
  const seen = new Set<string>(), sources: AskAnswer['sources'] = [];
  for (const chunk of candidate?.groundingMetadata?.groundingChunks || []) {
    const url = chunk?.web?.uri;
    if (typeof url !== 'string' || !/^https:\/\//.test(url) || seen.has(url)) continue;
    seen.add(url); sources.push({ title: String(chunk.web.title || new URL(url).hostname).slice(0, 120), url });
    if (sources.length >= 5) break;
  }
  return { text, sources, searched };
}

/** Which limit a 429 hit: per minute, per day, or no free allowance at all (limit 0). */
export function quotaWindow(json: any): { window: QuotaWindow; retrySeconds: number } {
  const details: any[] = Array.isArray(json?.error?.details) ? json.error.details : [];
  const text = `${json?.error?.message || ''} ${JSON.stringify(details)}`;
  const retry = details.find(item => String(item?.['@type'] || '').endsWith('RetryInfo'))?.retryDelay;
  const retrySeconds = Math.ceil(parseFloat(String(retry || '0')) || 0);
  if (/limit:\s*0\b|"quotaValue":"0"/.test(text)) return { window: 'none', retrySeconds };
  if (/PerDay/i.test(text)) return { window: 'day', retrySeconds };
  if (/PerMinute|per minute/i.test(text)) return { window: 'minute', retrySeconds };
  return { window: 'unknown', retrySeconds };
}

function failure(status: number, body: any): GeminiError {
  const json = Array.isArray(body) ? body[0] : body;
  const message = String(json?.error?.message || ''), reason = JSON.stringify(json?.error?.details || ''), detail = message.slice(0, 600);
  if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(message + reason)) return new GeminiError('Your Gemini API key was rejected. Check it in Google AI Studio, then save it again under Ask AI ⌄.', 'key', detail);
  if (status === 401 || status === 403) return new GeminiError('This Gemini API key is not allowed to use Gemini. Create a new key in Google AI Studio.', 'key', detail);
  if (status === 404 || (status === 400 && /not (found|supported)|unsupported/i.test(message))) return new GeminiError('This Gemini model is not available to your key.', 'unavailable', detail);
  if (status === 429) {
    const { window, retrySeconds } = quotaWindow(json);
    const text = window === 'minute' ? `Too many questions in one minute. Try again${retrySeconds ? ` in ${retrySeconds} seconds` : ' shortly'}.`
      : window === 'day' ? "Today's free Gemini allowance for your key is used up. It resets at midnight Pacific time; meanwhile use Ask Google."
      : window === 'none' ? 'Google gives this key no free Gemini allowance. If its project has billing (Tier 1), Google expects paid credit; otherwise create the key in a new project without billing in AI Studio.'
      : 'Google says this key is out of quota. Check the key’s plan and usage in Google AI Studio, or use Ask Google.';
    return new GeminiError(text, 'quota', detail, window, retrySeconds);
  }
  return new GeminiError(message ? `Gemini: ${message}` : `Gemini request failed (${status}).`, 'other', detail);
}

/**
 * Ask Gemini from the browser with the person's own key. Each model is tried
 * with Google Search grounding, then without it (search has its own
 * allowance); a model with no allowance for this key falls through to the
 * next. Key, safety, and network errors stop immediately. With `onText` the
 * answer streams in as it is written. Term look-ups skip search: they need
 * the thread, not the web, and search adds a wait.
 */
export async function askGemini(apiKey: string, request: AskRequest, options: { signal?: AbortSignal; fetcher?: typeof fetch; models?: string[]; onText?: (text: string) => void } = {}): Promise<AskAnswer> {
  const fetcher = options.fetcher || fetch, onText = options.onText;
  const send = async (model: string, search: boolean, step: number) => {
    let response: Response;
    try {
      response = await fetcher(`${ENDPOINT}/${model}:${onText ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, { method: 'POST', signal: options.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(geminiBody(request, search, model, step)) });
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error;
      throw new GeminiError('Could not reach Gemini. Check your connection.', 'network');
    }
    if (!response.ok) throw failure(response.status, await response.json().catch(() => null));
    onText?.('');
    let json: any;
    try { json = onText ? await readStream(response, onText) : await response.json().catch(() => null); }
    catch (error) {
      if ((error as Error)?.name === 'AbortError' || error instanceof GeminiError) throw error;
      throw new GeminiError('The connection to Gemini dropped while it was answering. Try again.', 'network');
    }
    return { ...readGeminiAnswer(json, search), model };
  };
  // A model that rejects a thinking setting is asked again with the next one; the accepted step is remembered.
  const call = async (model: string, search: boolean) => {
    const fast = request.mode === 'term', key = `${model}|${fast}`, last = thinkingConfigs(model, fast).length - 1;
    for (let step = acceptedThinking.get(key) || 0; ; step++) {
      try { const answer = await send(model, search, step); acceptedThinking.set(key, step); return answer; }
      catch (error) {
        if (step < last && error instanceof GeminiError && (error.kind === 'other' || error.kind === 'unavailable') && /thinking/i.test(error.detail)) continue;
        throw error;
      }
    }
  };
  const failures: GeminiError[] = [];
  for (const model of options.models || GEMINI_MODELS) {
    for (const search of request.mode === 'term' ? [false] : [true, false]) {
      try { return await call(model, search); }
      catch (error) {
        if (!(error instanceof GeminiError) || !['quota', 'unavailable', 'other'].includes(error.kind)) throw error;
        failures.push(error);
      }
    }
  }
  // Report the most useful reason: a short wait beats a daily limit beats no allowance.
  const rank = (error: GeminiError) => error.kind !== 'quota' ? 4 : ({ minute: 0, day: 1, unknown: 2, none: 3 } as const)[error.quota];
  throw [...failures].sort((a, b) => rank(a) - rank(b))[0] || new GeminiError('Gemini could not answer.', 'other');
}

/** Confirm Google accepts a key before saving it; a lightweight model listing, no generation. */
export async function verifyGeminiKey(apiKey: string, fetcher: typeof fetch = fetch): Promise<'ok' | 'offline'> {
  let response: Response;
  try { response = await fetcher(`${ENDPOINT}?pageSize=1`, { headers: { 'x-goog-api-key': apiKey.trim() } }); }
  catch { return 'offline'; }
  if (response.ok) return 'ok';
  throw failure(response.status, await response.json().catch(() => null));
}

/** Free fallback: Google Search AI Mode with the question filled in (opens a new tab). */
export const googleAiModeUrl = (question: string) => `https://www.google.com/search?udm=50&q=${encodeURIComponent(question.trim().slice(0, 1800))}`;
