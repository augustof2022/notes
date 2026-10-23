// This file runs only in Supabase Edge Functions. Never import it from the app.
import { createClient } from '@supabase/supabase-js';
import { importTokenKey } from './crypto.ts';
import { createDriveSessionHandler, DriveSessionError, type CredentialRow, type CredentialStore } from './handler.ts';

const allowedOrigins = (Deno.env.get('DRIVE_ALLOWED_ORIGINS') || '').split(',').map(value => value.trim()).filter(Boolean);
async function configure() {
  const url = Deno.env.get('SUPABASE_URL'), serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  const clientId = Deno.env.get('GOOGLE_CLIENT_ID'), clientSecret = Deno.env.get('GOOGLE_CLIENT_SECRET');
  const encryptionKey = Deno.env.get('DRIVE_TOKEN_ENCRYPTION_KEY');
  if (!url || !serviceKey || !clientId || !clientSecret || !encryptionKey || !allowedOrigins.length || allowedOrigins.includes('*')) throw new Error('Drive setup incomplete.');
  for (const origin of allowedOrigins) if (new URL(origin).origin !== origin) throw new Error('Drive origin is invalid.');
  const key = await importTokenKey(encryptionKey);
  const boundedFetch: typeof fetch = (input, init) => fetch(input, {
    ...init, signal: AbortSignal.any([AbortSignal.timeout(15000), ...(init?.signal ? [init.signal] : [])])
  });
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false }, global: { fetch: boundedFetch } });
  const columns = 'owner_id,google_subject,version,encrypted_payload,updated_at';
  const store: CredentialStore = {
    async read(owner) {
      const { data, error } = await admin.from('note_drive_credentials').select(columns).eq('owner_id', owner).maybeSingle();
      if (error) throw error;
      return data as CredentialRow | null;
    },
    async insert(row) {
      const { data, error } = await admin.from('note_drive_credentials').insert(row).select('version').maybeSingle();
      if (error?.code === '23505') return false;
      if (error) throw error;
      return !!data;
    },
    async replace(row, expectedVersion) {
      const { data, error } = await admin.from('note_drive_credentials').update(row).eq('owner_id', row.owner_id).eq('version', expectedVersion).select('version').maybeSingle();
      if (error) throw error;
      return !!data;
    }
  };
  return createDriveSessionHandler({
    store, key, clientId, clientSecret, allowedOrigins,
    async authenticate(jwt) {
      const { data, error } = await admin.auth.getUser(jwt);
      if (error && ![400, 401, 403].includes(error.status || 0)) throw new DriveSessionError(503, 'drive_temporarily_unavailable', 'Google Drive is temporarily unavailable. Retry in a moment.');
      return error ? null : data.user;
    }
  });
}
// Keep setup failures redacted; importing a missing key must not crash into an
// upstream response that includes sensitive details. No token/body is logged.
const handler = configure().then(value => ({ value }), () => ({ value: null }));
Deno.serve(async request => {
  const configured = await handler;
  if (configured.value) return configured.value(request);
  const origin = request.headers.get('origin');
  const headers = new Headers({ 'Content-Type': 'application/json', 'Cache-Control': 'no-store, private', Pragma: 'no-cache', Vary: 'Origin' });
  if (origin && allowedOrigins.includes(origin)) {
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Headers', 'authorization, apikey, content-type, x-client-info, x-supabase-api-version');
    headers.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  }
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  return new Response(JSON.stringify({ error: 'drive_setup_required', message: 'The app owner needs to finish the one-time Google Drive refresh setup.' }), { status: 503, headers });
});
