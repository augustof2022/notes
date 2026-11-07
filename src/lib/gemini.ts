/** Tried in order: a model with no free allowance for this key falls through to the next. */
export const GEMINI_MODELS = ['gemini-flash-latest', 'gemini-2.5-flash', 'gemini-flash-lite-latest', 'gemini-2.5-flash-lite'];
export const GEMINI_MODEL = GEMINI_MODELS[0];
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface AskImage { mimeType: string; data: string }
export interface AskRequest { question: string; context: string[]; images: AskImage[] }
export interface AskAnswer { text: string; sources: { title: string; url: string }[]; searched: boolean; model?: string }

export type QuotaWindow = 'minute' | 'day' | 'none' | 'unknown';
export class GeminiError extends Error {
  constructor(message: string, readonly kind: 'key' | 'quota' | 'unavailable' | 'blocked' | 'network' | 'other', readonly detail = '', readonly quota: QuotaWindow = 'unknown', readonly retrySeconds = 0) { super(message); }
}

const SYSTEM = 'You answer questions written on a personal note board. Reply concisely in Markdown: a direct answer first, then short bullet points only if they help. No preamble. Use the attached notes and images as context when the question refers to "this" or "that".';

export function geminiBody(request: AskRequest, search: boolean) {
  const notes = request.context.filter(text => text.trim()).map(text => `Note on the board:\n${text.trim()}`);
  return {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents: [{ role: 'user', parts: [
      ...request.images.map(image => ({ inline_data: { mime_type: image.mimeType, data: image.data } })),
      ...notes.map(text => ({ text })),
      { text: request.question.trim() },
    ] }],
    ...(search ? { tools: [{ google_search: {} }] } : {}),
  };
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

function failure(status: number, json: any): GeminiError {
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
 * next. Key, safety, and network errors stop immediately.
 */
export async function askGemini(apiKey: string, request: AskRequest, options: { signal?: AbortSignal; fetcher?: typeof fetch; models?: string[] } = {}): Promise<AskAnswer> {
  const fetcher = options.fetcher || fetch;
  const call = async (model: string, search: boolean) => {
    let response: Response;
    try {
      response = await fetcher(`${ENDPOINT}/${model}:generateContent`, { method: 'POST', signal: options.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(geminiBody(request, search)) });
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error;
      throw new GeminiError('Could not reach Gemini. Check your connection.', 'network');
    }
    const json = await response.json().catch(() => null);
    if (!response.ok) throw failure(response.status, json);
    return { ...readGeminiAnswer(json, search), model };
  };
  const failures: GeminiError[] = [];
  for (const model of options.models || GEMINI_MODELS) {
    for (const search of [true, false]) {
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
