import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

export const cloudConfigured = Boolean(supabaseUrl && supabaseAnonKey);

export const supabase = cloudConfigured
  ? createClient(supabaseUrl!, supabaseAnonKey!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;

export async function cloudApi<T>(
  route: string,
  init: RequestInit = {},
  organizationId?: string
): Promise<T> {
  if (!supabase) throw new Error("Mnema Cloud is not configured in this build.");
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error("Cloud session is missing or expired.");
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${data.session.access_token}`);
  headers.set("Content-Type", "application/json");
  if (organizationId) headers.set("X-Mnema-Organization-Id", organizationId);
  const response = await fetch(`/cloud/api${route}`, { ...init, headers });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof json.error === "string" ? json.error : `Cloud request failed (${response.status})`);
  return json as T;
}
