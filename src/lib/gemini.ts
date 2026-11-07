export const GEMINI_MODEL = 'gemini-flash-latest';
const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

export interface AskImage { mimeType: string; data: string }
export interface AskRequest { question: string; context: string[]; images: AskImage[] }
export interface AskAnswer { text: string; sources: { title: string; url: string }[]; searched: boolean }

export class GeminiError extends Error {
  constructor(message: string, readonly kind: 'key' | 'quota' | 'blocked' | 'network' | 'other') { super(message); }
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

function failure(status: number, json: any): GeminiError {
  const message = String(json?.error?.message || ''), reason = JSON.stringify(json?.error?.details || '');
  if (status === 400 && /API_KEY_INVALID|API key not valid/i.test(message + reason)) return new GeminiError('Your Gemini API key was rejected. Check it in Google AI Studio, then save it again in Settings → Ask AI.', 'key');
  if (status === 401 || status === 403) return new GeminiError('This Gemini API key is not allowed to use Gemini. Create a new key in Google AI Studio.', 'key');
  if (status === 429) return new GeminiError('Your free Gemini allowance is used up for now. Try again later, or use Ask Google.', 'quota');
  return new GeminiError(message ? `Gemini: ${message}` : `Gemini request failed (${status}).`, 'other');
}

/** Ask Gemini from the browser with the person's own key; Google Search grounding when the key allows it. */
export async function askGemini(apiKey: string, request: AskRequest, options: { signal?: AbortSignal; fetcher?: typeof fetch } = {}): Promise<AskAnswer> {
  const fetcher = options.fetcher || fetch;
  const call = async (search: boolean) => {
    let response: Response;
    try {
      response = await fetcher(`${ENDPOINT}/${GEMINI_MODEL}:generateContent`, { method: 'POST', signal: options.signal,
        headers: { 'content-type': 'application/json', 'x-goog-api-key': apiKey }, body: JSON.stringify(geminiBody(request, search)) });
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') throw error;
      throw new GeminiError('Could not reach Gemini. Check your connection.', 'network');
    }
    const json = await response.json().catch(() => null);
    if (!response.ok) throw failure(response.status, json);
    return readGeminiAnswer(json, search);
  };
  try { return await call(true); }
  catch (error) {
    // Search grounding has its own allowance; still answer without it.
    if (error instanceof GeminiError && (error.kind === 'quota' || error.kind === 'other')) {
      try { return await call(false); } catch (retry) { throw retry instanceof GeminiError && retry.kind !== 'other' ? retry : error; }
    }
    throw error;
  }
}

/** Free fallback: Google Search AI Mode with the question filled in (opens a new tab). */
export const googleAiModeUrl = (question: string) => `https://www.google.com/search?udm=50&q=${encodeURIComponent(question.trim().slice(0, 1800))}`;
