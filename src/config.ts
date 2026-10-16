// Browser-safe configuration. This key grants no access without the RLS policies
// and a signed-in app user. Never replace it with a secret/service-role key.
export const appConfig = {
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL || 'https://wrkoxjlzdeiffdtgbyvq.supabase.co',
  supabaseKey: import.meta.env.VITE_SUPABASE_ANON_KEY || 'sb_publishable_DTTaBe55F0E-GApDcC1Y2Q_uaaDcqYY',
};
