import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** Server-side client using the service-role key. Never import this from client-side code. */
export function createSupabase(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { 'x-application-name': 'telegram-support-bot' } },
  });
}
