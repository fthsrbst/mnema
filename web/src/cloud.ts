import { createClient } from "@supabase/supabase-js";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL?.trim();
const supabasePublicKey =
  import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY?.trim() ||
  import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

export const cloudConfigured = Boolean(supabaseUrl && supabasePublicKey);
export const googleAuthEnabled = import.meta.env.VITE_CLOUD_GOOGLE_AUTH_ENABLED?.trim() === "true";

export const supabase = cloudConfigured
  ? createClient(supabaseUrl!, supabasePublicKey!, {
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
  const response = await fetch(`/cloud/api${route}`, { ...init, headers, cache: init.cache ?? "no-store" });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) throw new Error(typeof json.error === "string" ? json.error : `Cloud request failed (${response.status})`);
  return json as T;
}

export async function downloadCloudExport(organizationId: string, filename: string): Promise<void> {
  if (!supabase) throw new Error("Mnema Cloud is not configured in this build.");
  const { data, error } = await supabase.auth.getSession();
  if (error || !data.session) throw new Error("Cloud session is missing or expired.");
  const response = await fetch("/cloud/api/organizations/export", {
    headers: {
      Authorization: `Bearer ${data.session.access_token}`,
      "X-Mnema-Organization-Id": organizationId,
    },
  });
  if (!response.ok) {
    const payload = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(payload.error ?? `Cloud export failed (${response.status})`);
  }
  const blob = await response.blob();
  const url = URL.createObjectURL(blob);
  try {
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.click();
  } finally {
    URL.revokeObjectURL(url);
  }
}
