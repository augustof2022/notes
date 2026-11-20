/** Tried in order: a model with no free allowance for this key falls through to the next. */
export const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'];
export const GEMINI_MODEL = GEMINI_MODELS[0];
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface AskImage { mimeType: string; data: string }
/**
 * 'ask' (the default) is clean: only the context, what was selected, and the
 * person's prompt as typed; no system instruction (Renz, 2026-11-20).
 * 'explain' explains selected words or a picture, with the app's rules and
 * the saved instruction, fast and without search.
 */
export type AskMode = 'ask' | 'explain';
/** `focus`: the words selected (a note's words, or a whole text box). `picture`: Explain is about a picture or drawing, not words. */
export interface AskRequest { question: string; context: string[]; images: AskImage[]; instruction?: string; mode?: AskMode; focus?: string; picture?: boolean }
export interface AskAnswer { text: string; sources: { title: string; url: string }[]; searched: boolean; model?: string }

export type QuotaWindow = 'minute' | 'day' | 'none' | 'unknown';
export class GeminiError extends Error {
  constructor(message: string, readonly kind: 'key' | 'quota' | 'unavailable' | 'blocked' | 'network' | 'slow' | 'other', readonly detail = '', readonly quota: QuotaWindow = 'unknown', readonly retrySeconds = 0) { super(message); }
}

const BASE = 'You answer questions written on a personal note board, in Markdown. Use the attached notes and images as context when the question refers to "this" or "that".';
/** Used only where the person's own instruction says nothing about length or format. */
const DEFAULTS = "Defaults (the person's own instruction, if any, overrides them): a direct answer first, then short bullet points only if they help. No preamble.";
const EXPLAIN = 'The person selected words in a note and asked you to explain them, in the sense they have in that note. After the explanation, add one line that starts with "Origin:" and gives the real etymology of the words. If you do not know a real etymology, write instead one line that starts with "Memory hook (made up):" with a short invented story that anchors the meaning; never present a made-up origin as real.';
/** Explain on a picture or drawing: no word origin, since there are no words to trace. */
const EXPLAIN_PICTURE = 'The person selected a picture or drawing on their board and asked you to explain it: what it shows and what it means, in the sense it has among their notes.';
export const MAX_INSTRUCTION = 2000;

/**
 * Explain only (Ask sends no system instruction). The person's own
 * instruction comes first and wins over the app's defaults (it used to come
 * last and lose to "reply concisely", so it looked ignored).
 */
export function systemText(request: Pick<AskRequest, 'instruction' | 'picture'>) {
  const own = (request.instruction || '').trim().slice(0, MAX_INSTRUCTION);
  return [own ? `The person's own instruction for HOW to answer (style, tone, length, format). Follow it over the defaults below. It never changes WHAT to answer: always answer the question actually asked.\n${own}` : '',
    BASE, request.picture ? EXPLAIN_PICTURE : EXPLAIN, DEFAULTS].filter(Boolean).join('\n\n');
}

/**
 * The message parts. Explain labels the notes for its system rules. Ask is
 * plain: pictures, then "Context:" (the thread and selected notes), then
 * "Selected:" (the words or text box it is about), then the prompt as typed.
 */
export function promptParts(request: AskRequest) {
  const images = request.images.map(image => ({ inline_data: { mime_type: image.mimeType, data: image.data } }));
  const context = request.context.map(text => text.trim()).filter(Boolean);
  if (request.mode === 'explain') return [...images, ...context.map(text => ({ text: `Note on the board:\n${text}` })), { text: request.question.trim() }];
  return [...images,
    ...(context.length ? [{ text: `Context:\n${context.join('\n\n')}` }] : []),
    ...(request.focus?.trim() ? [{ text: `Selected:\n${request.focus.trim()}` }] : []),
    { text: request.question.trim() }];
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

/** Explain and Ask both use the fastest thinking setting: speed matters more on a note board (Renz, 2026-11-20). */
const FAST = true;

export function geminiBody(request: AskRequest, search: boolean, model = '', step = 0) {
  const config = thinkingConfigs(model, FAST)[step];
  return {
    ...(request.mode === 'explain' ? { systemInstruction: { parts: [{ text: systemText(request) }] } } : {}),
    contents: [{ role: 'user', parts: promptParts(request) }],
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

async function readStream(response: Response, onText: (text: string) => void, onFirst: () => void = () => undefined) {
  const chunks: any[] = [];
  const take = (found: any[]) => { if (!found.length) return; onFirst(); chunks.push(...found); const merged = mergeStreamChunks(chunks); onText(merged.candidates[0].content.parts[0]?.text || ''); };
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
export async function askGemini(apiKey: string, request: AskRequest, options: { signal?: AbortSignal; fetcher?: typeof fetch; models?: string[]; onText?: (text: string) => void; firstByteMs?: number; now?: () => number } = {}): Promise<AskAnswer> {
  const fetcher = options.fetcher || fetch, onText = options.onText, now = options.now || Date.now, outer = options.signal;
  const send = async (model: string, search: boolean, step: number) => {
    // Each try has its own cancel: the person's Cancel stops it, and so does a model that has not started answering in time (often "overloaded").
    const attempt = new AbortController(), started = now(), stop = () => attempt.abort();
    let slow = false;
    const timer = setTimeout(() => { slow = true; attempt.abort(); }, options.firstByteMs ?? FIRST_BYTE_MS);
    const first = () => clearTimeout(timer);
    if (outer?.aborted) attempt.abort(); else outer?.addEventListener('abort', stop);
    const late = () => { trace(model, search, 'no words in time', started, now); return new GeminiError('Gemini took too long to start answering.', 'slow'); };
    try {
      let response: Response;
      try {
        response = await fetcher(`${ENDPOINT}/${model}:${onText ? 'streamGenerateContent?alt=sse' : 'generateContent'}`, { method: 'POST', signal: attempt.signal,
          headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(geminiBody(request, search, model, step)) });
      } catch (error) {
        if (slow) throw late();
        if ((error as Error)?.name === 'AbortError') throw error;
        throw new GeminiError('Could not reach Gemini. Check your connection.', 'network');
      }
      if (!response.ok) {
        first();
        const error = failure(response.status, await response.json().catch(() => null));
        trace(model, search, `${response.status} ${error.kind}${error.kind === 'quota' ? ` (${error.quota})` : ''}`, started, now);
        throw error;
      }
      onText?.('');
      let json: any;
      try { json = onText ? await readStream(response, onText, first) : await response.json().catch(() => null); }
      catch (error) {
        if (slow) throw late();
        if ((error as Error)?.name === 'AbortError' || error instanceof GeminiError) throw error;
        throw new GeminiError('The connection to Gemini dropped while it was answering. Try again.', 'network');
      }
      first();
      trace(model, search, 'answered', started, now);
      return { ...readGeminiAnswer(json, search), model };
    } finally { clearTimeout(timer); outer?.removeEventListener('abort', stop); }
  };
  // A model that rejects a thinking setting is asked again with the next one; the accepted step is remembered.
  const call = async (model: string, search: boolean) => {
    const key = `${model}|${FAST}`, last = thinkingConfigs(model, FAST).length - 1;
    for (let step = acceptedThinking.get(key) || 0; ; step++) {
      try { const answer = await send(model, search, step); acceptedThinking.set(key, step); return answer; }
      catch (error) {
        if (step < last && error instanceof GeminiError && (error.kind === 'other' || error.kind === 'unavailable') && /thinking/i.test(error.detail)) continue;
        throw error;
      }
    }
  };
  const failures: GeminiError[] = [];
  for (const [model, search] of routeOrder(options.models || GEMINI_MODELS, request.mode === 'explain' ? [false] : [true, false], now())) {
    try { const answer = await call(model, search); lastGood = routeKey(model, search); cooling.delete(lastGood); return answer; }
    catch (error) {
      if (!(error instanceof GeminiError) || !['quota', 'unavailable', 'other', 'slow'].includes(error.kind)) throw error;
      cooling.set(routeKey(model, search), now() + coolMs(error));
      failures.push(error);
    }
  }
  // Report the most useful reason: a short wait beats a daily limit beats no allowance.
  const rank = (error: GeminiError) => error.kind !== 'quota' ? 4 : ({ minute: 0, day: 1, unknown: 2, none: 3 } as const)[error.quota];
  throw [...failures].sort((a, b) => rank(a) - rank(b))[0] || new GeminiError('Gemini could not answer.', 'other');
}

/** How long a model may take to send its first words before the next one is tried. */
export const FIRST_BYTE_MS = 20000;

/**
 * Why later questions got slow: every question started again at the first
 * model with search, so once the free per-minute limit was hit, each one
 * waited through the same failed tries. Now a route (model + search) that
 * failed rests for a while, and the last route that answered goes first.
 */
const cooling = new Map<string, number>();
let lastGood = '';
export const forgetRoutes = () => { cooling.clear(); lastGood = ''; };
const routeKey = (model: string, search: boolean) => `${model}|${search ? 'search' : 'plain'}`;
export function coolMs(error: GeminiError) {
  const minute = 60_000;
  if (error.kind === 'quota') return error.quota === 'minute' ? Math.max(error.retrySeconds, 20) * 1000 : error.quota === 'day' ? 60 * minute : error.quota === 'none' ? 24 * 60 * minute : 10 * minute;
  if (error.kind === 'unavailable') return 24 * 60 * minute;
  if (error.kind === 'slow') return 2 * minute;
  return minute;
}
/** Routes to try: rested ones first (the last good one at the front), then resting ones, soonest-ready first, as a last resort. */
export function routeOrder(models: readonly string[], searches: readonly boolean[], at: number): [string, boolean][] {
  const all = models.flatMap(model => searches.map(search => [model, search] as [string, boolean]));
  const until = (route: [string, boolean]) => cooling.get(routeKey(...route)) || 0;
  const ready = all.filter(route => until(route) <= at), resting = all.filter(route => until(route) > at).sort((a, b) => until(a) - until(b));
  const good = ready.findIndex(route => routeKey(...route) === lastGood);
  if (good > 0) ready.unshift(...ready.splice(good, 1));
  return [...ready, ...resting];
}
/** One line per try in the browser console (model, search, result, time), to see where a slow answer spent its time. */
function trace(model: string, search: boolean, result: string, started: number, now: () => number) {
  try { console.info(`[Ask AI] ${model}${search ? ' +search' : ''}: ${result} in ${now() - started} ms`); } catch { /* console is optional */ }
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
