import { expect, it } from 'vitest';
import { looksLikeGeminiKey, sealAiKey, unlockAiKey, WrongPassphraseError } from './ai-key';

const KEY = 'AIzaSyD-example_key_value_1234567890abcd';

it('stores only ciphertext and unlocks with the right passphrase', async () => {
  const { sealed } = await sealAiKey(KEY, 'correct horse battery', 100_000);
  expect(JSON.stringify(sealed)).not.toContain(KEY);
  expect(JSON.stringify(sealed)).not.toContain('correct horse');
  expect(sealed.iterations).toBe(100_000);
  expect((await unlockAiKey(sealed, 'correct horse battery')).apiKey).toBe(KEY);
});

it('rejects a wrong passphrase and uses a fresh salt and IV every time', async () => {
  const first = (await sealAiKey(KEY, 'passphrase-one', 100_000)).sealed, second = (await sealAiKey(KEY, 'passphrase-one', 100_000)).sealed;
  await expect(unlockAiKey(first, 'passphrase-two')).rejects.toBeInstanceOf(WrongPassphraseError);
  expect(first.salt).not.toBe(second.salt); expect(first.iv).not.toBe(second.iv); expect(first.ciphertext).not.toBe(second.ciphertext);
});

it('recognizes the shape of a Gemini key', () => {
  expect(looksLikeGeminiKey(` ${KEY} `)).toBe(true);
  expect(looksLikeGeminiKey('my password')).toBe(false);
});
