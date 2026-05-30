import 'server-only';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/* Service-role client for the noli-core Supabase project. CRM keeps its own
 * Postgres on Hetzner via MikroORM (see DATABASE_URL); these helpers ONLY
 * speak to noli-core, the cross-app users + entitlements + ai_usage store.
 *
 * Inlined from packages/entitlements-client in the noli-platform monorepo —
 * same shape as apps/dashboard/src/lib/noli/core-client.ts in blog-ops (AMS).
 * If we eventually publish that package to npm we can swap this for an
 * import; for now copying the ~30 lines we need is simpler than wiring
 * cross-repo workspace deps. */

let cached: SupabaseClient | null = null;

export function getNoliCoreClient(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.NOLI_CORE_SUPABASE_URL;
  const key = process.env.NOLI_CORE_SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error('NOLI_CORE_SUPABASE_URL is not set');
  if (!key) throw new Error('NOLI_CORE_SUPABASE_SERVICE_ROLE_KEY is not set');
  cached = createClient(url, key, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { 'x-application-name': 'noli-crm-server' } },
  });
  return cached;
}

/* The shape of a noli-core users row that CRM cares about. */
export type NoliCoreUser = {
  id: string;
  clerk_user_id: string;
  email: string;
  first_name: string | null;
  last_name: string | null;
  cohort: 'pure-saas' | 'launch-pad';
};

/* Look up a noli-core user by their Clerk identity. Returns null if not
 * yet synced (e.g. the Clerk user.created webhook hasn't landed). */
export async function findUserByClerkId(
  clerkUserId: string,
): Promise<NoliCoreUser | null> {
  const supabase = getNoliCoreClient();
  const { data, error } = await supabase
    .from('users')
    .select('id, clerk_user_id, email, first_name, last_name, cohort')
    .eq('clerk_user_id', clerkUserId)
    .maybeSingle();
  if (error) throw error;
  return (data as NoliCoreUser | null) ?? null;
}

/* Look up a noli-core user by their noli-core UUID. Used by the internal
 * connectivity endpoint, which receives a noliUserId (not a Clerk id) from a
 * sibling app and needs the Clerk id to resolve/provision the Mercato user. */
export async function findNoliUserById(
  noliUserId: string,
): Promise<NoliCoreUser | null> {
  const supabase = getNoliCoreClient();
  const { data, error } = await supabase
    .from('users')
    .select('id, clerk_user_id, email, first_name, last_name, cohort')
    .eq('id', noliUserId)
    .maybeSingle();
  if (error) throw error;
  return (data as NoliCoreUser | null) ?? null;
}

/* The noli-core organization the user belongs to (v1 = one org per user).
 * Used to map a whole noli-core team onto ONE shared Mercato org. Returns
 * null if the user has no org membership yet. */
export async function findPrimaryOrgIdForUser(
  noliUserId: string,
): Promise<string | null> {
  const supabase = getNoliCoreClient();
  const { data, error } = await supabase
    .from('organization_members')
    .select('organization_id')
    .eq('user_id', noliUserId)
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  return (data?.organization_id as string | undefined) ?? null;
}

/* Check whether a noli-core user has an active entitlement for a given
 * Noli app. Used by the Clerk auth resolver to gate access to CRM. */
export async function isEntitled(
  noliUserId: string,
  app: 'crm' | 'ams' | 'kb' | 'pm' | 'cos',
): Promise<boolean> {
  const supabase = getNoliCoreClient();
  const { data, error } = await supabase
    .from('entitlements')
    .select('active')
    .eq('user_id', noliUserId)
    .eq('app', app)
    .maybeSingle();
  if (error) throw error;
  return Boolean(data?.active);
}
