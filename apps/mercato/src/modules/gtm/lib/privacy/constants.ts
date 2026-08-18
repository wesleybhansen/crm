// Global privacy rows need non-null tenant columns but intentionally belong to
// no customer tenant. Keep the sentinel in one dependency-neutral module so
// suppression and deletion code cannot form an import cycle.
export const GLOBAL_SUPPRESSION_ORG_ID = '00000000-0000-0000-0000-000000000000'
export const GLOBAL_SUPPRESSION_TENANT_ID = '00000000-0000-0000-0000-000000000000'
