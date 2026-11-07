import { expect, it, vi } from 'vitest';
import { askGemini, geminiBody, GeminiError, googleAiModeUrl, verifyGeminiKey } from './gemini';

const reply = (status: number, body: object) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } }));
const answer = { candidates: [{ content: { parts: [{ text: 'A **heat pump**.' }] }, groundingMetadata: { groundingChunks: [{ web: { uri: 'https://example.com/a', title: 'Example' } }, { web: { uri: 'https://example.com/a', title: 'Dup' } }, { web: { uri: 'javascript:alert(1)', title: 'Bad' } }] } }] };
const request = { question: 'What is this?', context: ['Aircon splittype'], images: [{ mimeType: 'image/png', data: 'AAAA' }] };

it('sends the key in a header, the notes and pictures as parts, and asks with Google Search', async () => {
  const fetcher = vi.fn(() => reply(200, answer)) as unknown as typeof fetch;
  const result = await askGemini('KEY123', request, { fetcher });
  const [url, init] = (fetcher as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
  expect(url).not.toContain('KEY123');
  expect(init.headers['x-goog-api-key']).toBe('KEY123');
  expect(JSON.parse(init.body).tools).toEqual([{ google_search: {} }]);
  expect(result).toEqual({ text: 'A **heat pump**.', sources: [{ title: 'Example', url: 'https://example.com/a' }], searched: true, model: 'gemini-flash-latest' });
  expect(geminiBody(request, false).contents[0].parts).toEqual([{ inline_data: { mime_type: 'image/png', data: 'AAAA' } }, { text: 'Note on the board:\nAircon splittype' }, { text: 'What is this?' }]);
});

it('still answers without search when the search allowance is used up', async () => {
  const fetcher = vi.fn().mockReturnValueOnce(reply(429, { error: { message: 'quota' } })).mockReturnValueOnce(reply(200, answer)) as unknown as typeof fetch;
  const result = await askGemini('KEY', request, { fetcher });
  expect(result.searched).toBe(false);
});

const noFree = { error: { code: 429, message: 'You exceeded your current quota. Quota exceeded for metric: generativelanguage.googleapis.com/generate_content_free_tier_requests, limit: 0, model: gemini-3-flash', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } };

it('falls through to a model that has a free allowance for this key', async () => {
  const fetcher = vi.fn((url: string) => url.includes('/gemini-flash-latest:') ? reply(429, noFree) : reply(200, answer)) as unknown as typeof fetch;
  const result = await askGemini('KEY', request, { fetcher });
  expect(result).toMatchObject({ model: 'gemini-2.5-flash', searched: true });
});

it('tells per-minute limits, daily limits, and no free allowance apart, keeping Google’s message', async () => {
  const minute = { error: { message: 'Quota exceeded for metric: requests per minute', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '37s' }] } };
  const daily = { error: { message: 'Quota exceeded', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }] } };
  const always = (body: object) => vi.fn(() => reply(429, body)) as unknown as typeof fetch;
  await expect(askGemini('KEY', request, { fetcher: always(minute) })).rejects.toMatchObject({ quota: 'minute', retrySeconds: 37, message: expect.stringContaining('37 seconds') });
  await expect(askGemini('KEY', request, { fetcher: always(daily) })).rejects.toMatchObject({ quota: 'day' });
  await expect(askGemini('KEY', request, { fetcher: always(noFree) })).rejects.toMatchObject({ quota: 'none', detail: expect.stringContaining('limit: 0') });
});

it('explains a rejected key and an exhausted allowance', async () => {
  const bad = vi.fn(() => reply(400, { error: { message: 'API key not valid. Please pass a valid API key.' } })) as unknown as typeof fetch;
  await expect(askGemini('KEY', request, { fetcher: bad })).rejects.toMatchObject({ kind: 'key' });
  const empty = vi.fn(() => reply(429, { error: { message: 'quota' } })) as unknown as typeof fetch;
  await expect(askGemini('KEY', request, { fetcher: empty })).rejects.toBeInstanceOf(GeminiError);
  await expect(askGemini('KEY', request, { fetcher: empty })).rejects.toMatchObject({ kind: 'quota' });
});

it('builds a Google AI Mode link for the free fallback', () => {
  expect(googleAiModeUrl('what is R32?')).toBe('https://www.google.com/search?udm=50&q=what%20is%20R32%3F');
});

it('checks a key with Google before it is saved', async () => {
  await expect(verifyGeminiKey('KEY', vi.fn(() => reply(200, { models: [] })) as unknown as typeof fetch)).resolves.toBe('ok');
  await expect(verifyGeminiKey('KEY', vi.fn(() => reply(400, { error: { message: 'API key not valid.' } })) as unknown as typeof fetch)).rejects.toMatchObject({ kind: 'key' });
  await expect(verifyGeminiKey('KEY', vi.fn(() => Promise.reject(new TypeError('offline'))) as unknown as typeof fetch)).resolves.toBe('offline');
});
