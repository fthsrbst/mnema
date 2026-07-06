// Hub REST istemcisi — aynı origin'den servis edilir; token localStorage'da tutulur.

export function getToken(): string {
  return localStorage.getItem("hub_token") ?? "";
}

export function setToken(token: string): void {
  localStorage.setItem("hub_token", token);
}

export async function api<T = unknown>(method: string, route: string, body?: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  const token = getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(route, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status}: ${text.slice(0, 200)}`);
  }
  return (await res.json()) as T;
}

export interface Memory {
  id: number;
  type: string;
  title: string;
  body: string;
  project: string | null;
  tags: string[];
  source: string | null;
  updated_at: string;
  score?: number;
}

export interface ProjectMap {
  name: string;
  status?: string;
  summary?: string;
  stack?: string[];
  repo?: string;
  current_focus?: string;
  decisions?: string[];
  next_steps?: string[];
  updated_at?: string;
}

export interface SessionLog {
  id: number;
  project: string | null;
  summary: string;
  source: string | null;
  created_at: string;
}

export interface MachineStatus {
  name: string;
  host: string;
  lmstudio: { online: boolean; models: string[] };
  comfyui: { online: boolean };
}

export interface Skill {
  name: string;
  description: string;
  content: string;
}

export interface OutputFile {
  name: string;
  url: string;
  size: number;
  mtime: number;
}
