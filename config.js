// ─── POLPO NETWORK :: SUPABASE CONFIG ──────────────────────
// -bynd
// Reemplaza con tus credenciales del proyecto.
// La anon key es PÚBLICA por diseño. La seguridad real la dan
// las RLS policies (ver README).
// ───────────────────────────────────────────────────────────

window.POLPO_NETWORK_CONFIG = {
  SUPABASE_URL: 'https://TU-PROYECTO.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOi...PEGA_TU_ANON_KEY',

  // Tabla a leer
  TABLE: 'stand_users',

  // Columnas que necesita el grafo (mantén el orden si quieres)
  COLUMNS: 'username,status,mutual,origen,followed_at,mutual_checked_at,profile_followers,profile_following,profile_ratio,stand_type,days_active'
};
