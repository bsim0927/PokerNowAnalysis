/**
 * Thin fetch-based Supabase client using the service role key.
 *
 * Uses POST /rest/v1/rpc/execute_sql — a database function you create once:
 *
 *   create or replace function execute_sql(query text)
 *   returns jsonb
 *   language plpgsql
 *   security definer
 *   set search_path = public
 *   as $$
 *   declare
 *     result jsonb;
 *   begin
 *     execute format(
 *       'select coalesce(json_agg(row_to_json(t)), ''[]''::json) from (%s) t',
 *       query
 *     ) into result;
 *     return result;
 *   end;
 *   $$;
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

export async function sql<T>(query: string): Promise<T[]> {
  if (!SUPABASE_URL || !KEY) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set in environment');
  }

  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/execute_sql`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${KEY}`,
      'apikey': KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Supabase RPC error ${res.status}: ${body}`);
  }

  const data = await res.json();
  // execute_sql returns a jsonb array; PostgREST passes it through as-is
  return (Array.isArray(data) ? data : []) as T[];
}
