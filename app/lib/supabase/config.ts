/**
 * Whether Supabase credentials are present.
 *
 * The marketing site must work without them, so every entry point that would
 * build a Supabase client checks this first and degrades gracefully instead
 * of throwing.
 */
export function hasSupabaseConfig() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
}
