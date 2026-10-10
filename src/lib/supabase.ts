import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { Settings } from '../types';
import { createAuthStorage } from './auth-storage';
let cached: SupabaseClient | null = null; let signature = '';
export function getSupabase(settings: Settings) {
  if (!settings.supabaseUrl || !settings.supabaseKey) return null;
  const next = `${settings.supabaseUrl}|${settings.supabaseKey}`;
  if (cached && signature === next) return cached;
  if (cached) void cached.auth.stopAutoRefresh();
  signature = next;
  cached = createClient(settings.supabaseUrl, settings.supabaseKey, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, storage: createAuthStorage(localStorage) } });
  return cached;
}
export function validateCloudSettings(url: string, key: string) {
  if (!url && !key) return;
  try { const parsed = new URL(url); if (parsed.protocol !== 'https:' && parsed.hostname !== 'localhost' && parsed.hostname !== '127.0.0.1') throw new Error(); }
  catch { throw new Error('Use the HTTPS project URL shown in your Supabase dashboard.'); }
  if (!key) throw new Error('Add the Supabase publishable or anon key.');
  if (key.startsWith('sb_secret_')) throw new Error('Use the publishable key, never a secret or service-role key.');
  if (key.split('.').length === 3) {
    try { const payload = JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))); if (payload.role === 'service_role') throw new Error('Use the anon key, never a service-role key.'); }
    catch (error) { if (error instanceof Error && error.message.includes('service-role')) throw error; }
  }
}
