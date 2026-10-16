import 'fake-indexeddb/auto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSettings, storeSettings, watchSettings } from './db';

afterEach(() => vi.unstubAllGlobals());

describe('settings across open Note tabs', () => {
  it('ignores old connection overrides and retains only personal preferences', () => {
    const saved = JSON.stringify({ supabaseUrl: 'https://changed.invalid', supabaseKey: 'edited-key', imageStore: 'drive', ocrEnabled: false, theme: 'dark' });
    vi.stubGlobal('localStorage', { getItem: () => saved });
    expect(getSettings()).toEqual({ imageStore: 'drive', ocrEnabled: false, theme: 'dark' });
  });
  it('does not write connection details back into browser preferences', () => {
    const setItem = vi.fn();
    vi.stubGlobal('localStorage', { setItem });
    const legacy = { supabaseUrl: 'https://changed.invalid', supabaseKey: 'edited-key', imageStore: 'supabase' as const, ocrEnabled: true, theme: 'light' as const };
    storeSettings(legacy);
    expect(JSON.parse(setItem.mock.calls[0][1])).toEqual({ imageStore: 'supabase', ocrEnabled: true, theme: 'light' });
  });
  it('updates an already open tab when another tab selects Google Drive', () => {
    let saved: string | null = null;
    const storage = { getItem: () => saved, setItem: (_key: string, value: string) => { saved = value; } };
    const events = new EventTarget();
    vi.stubGlobal('localStorage', storage); vi.stubGlobal('window', events);
    const changed = vi.fn();
    const stop = watchSettings(changed);
    storeSettings({ ...getSettings(), imageStore: 'drive' });
    const event = () => Object.assign(new Event('storage'), { key: 'note-settings', storageArea: storage });
    events.dispatchEvent(event());
    expect(changed).toHaveBeenCalledWith(expect.objectContaining({ imageStore: 'drive' }));
    stop(); events.dispatchEvent(event());
    expect(changed).toHaveBeenCalledTimes(1);
  });
  it('ignores auth and other storage events so they cannot reset the selected destination', () => {
    const storage = { getItem: () => null };
    const events = new EventTarget();
    vi.stubGlobal('localStorage', storage); vi.stubGlobal('window', events);
    const changed = vi.fn(); const stop = watchSettings(changed);
    events.dispatchEvent(Object.assign(new Event('storage'), { key: 'auth-session', storageArea: storage }));
    events.dispatchEvent(Object.assign(new Event('storage'), { key: 'note-settings', storageArea: {} }));
    expect(changed).not.toHaveBeenCalled(); stop();
  });
});
