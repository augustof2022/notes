import type { SupabaseClient } from '@supabase/supabase-js';

export function needsCreationDateRepair(message: string) {
  return /(?:column\s+["']?created_at(?:_estimated)?["']?.*(?:does not exist|schema cache)|record ["'](?:old|new)["'] has no field ["']created_at(?:_estimated)?["'])/i.test(message);
}

// Old tables can coexist with a newer save_note function after a partial SQL
// upgrade. Use the existing owner policies and compare-and-swap revision check
// for this specific failure only. Never upsert or retry other database errors.
export async function saveCloudRecord(client: SupabaseClient, scope: string, kind: 'board' | 'folder', record: Record<string, unknown>, revision: number, assertCurrent: () => void) {
  const result = await client.rpc('save_note', { p_kind: kind, p_record: record, p_expected_revision: revision });
  assertCurrent();
  if (result.error?.code !== '42703' || !needsCreationDateRepair(result.error.message)) return result;
  const { created_at: _created, created_at_estimated: _estimated, id, ...fields } = record;
  const table = client.from(kind === 'board' ? 'note_boards' : 'note_folders');
  const query = revision === 0
    ? table.insert({ id, ...fields, owner_id: scope, revision: 1 })
    : table.update({ ...fields, revision: revision + 1, updated_at: 'now' }).eq('owner_id', scope).eq('id', id).eq('revision', revision);
  const saved = await query.select('*').maybeSingle();
  assertCurrent();
  if ((!saved.error && !saved.data) || (revision === 0 && saved.error?.code === '23505')) {
    return { data: null, error: { message: 'NOTE_CONFLICT' } };
  }
  return saved;
}
