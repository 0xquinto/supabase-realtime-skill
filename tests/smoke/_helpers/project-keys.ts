// tests/smoke/_helpers/project-keys.ts
//
// Branch creation does not return anon/service_role keys — they live behind
// a separate Management API endpoint. We can't extend the vendored ApiClient
// (foundation snapshot policy), so we hit the endpoint directly here.
//
// Extracted from tests/smoke/watch-table.smoke.test.ts so T9 (eval/spike-latency.ts)
// can reuse without copy-paste.

export interface ProjectKeys {
  anon: string;
  serviceRole: string;
}

export async function fetchProjectKeys(pat: string, projectRef: string): Promise<ProjectKeys> {
  const res = await fetch(`https://api.supabase.com/v1/projects/${projectRef}/api-keys`, {
    headers: { Authorization: `Bearer ${pat}` },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`fetch api-keys failed: ${res.status} ${res.statusText} ${body}`);
  }
  const keys = (await res.json()) as Array<{ name?: string; api_key?: string }>;
  const anon = keys.find((k) => k.name === "anon")?.api_key;
  const serviceRole = keys.find((k) => k.name === "service_role")?.api_key;
  if (!anon) throw new Error(`no anon key in api-keys response for ${projectRef}`);
  if (!serviceRole) throw new Error(`no service_role key for ${projectRef}`);
  return { anon, serviceRole };
}
