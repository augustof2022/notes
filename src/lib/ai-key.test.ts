import { expect, it } from 'vitest';
import { geminiKeyProblem, sealAiKey, unlockAiKey, WrongPassphraseError } from './ai-key';

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

it('accepts any key-shaped value and explains common copy mistakes', () => {
  expect(geminiKeyProblem(` ${KEY} `)).toBeNull();
  expect(geminiKeyProblem('AQ.Ab8RN6Example-newer.key_format123456')).toBeNull();
  expect(geminiKeyProblem('gen-lang-client-0873496628')).toMatch(/Project ID/);
  expect(geminiKeyProblem('...-lpw')).toMatch(/end of the key/);
  expect(geminiKeyProblem('my api key here please')).toMatch(/spaces/);
});
