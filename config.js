// ─── POLPO NETWORK :: SUPABASE CONFIG ──────────────────────
// -bynd
// Reemplaza con tus credenciales del proyecto.
// La anon key es PÚBLICA por diseño. La seguridad real la dan
// las RLS policies (ver README).
// ───────────────────────────────────────────────────────────

window.POLPO_NETWORK_CONFIG = {
  SUPABASE_URL: 'https://jlgudpcsgbzqiryuoxam.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpsZ3VkcGNzZ2J6cWlyeXVveGFtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzc4MjQ3NzQsImV4cCI6MjA5MzQwMDc3NH0.64Ox8kprffYrVaRvyDP95uV8f3mO2wzcmxJxh257_MM',

  // Tabla a leer
  TABLE: 'stand_users',

  // Columnas que necesita el grafo (mantén el orden si quieres)
 COLUMNS: 'username,status,mutual,origen,followed_at,mutual_checked_at,profile_followers,profile_following,profile_ratio,stand_type,unfollowed_at,last_updated'
};
