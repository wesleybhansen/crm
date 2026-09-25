-- READ-ONLY. Who holds super-admin rights in the CRM database.
-- is_super_admin bypasses every organisation boundary, and every Noli
-- customer shares one tenant, so any holder other than the platform
-- operators can read and write every customer's CRM. Until 2026-09-24 the
-- team invite-accept and team role-change routes minted
-- role_acls(is_super_admin = true) for the `admin` role when that role had
-- no ACL yet.
-- Run:  psql "$DATABASE_URL" -f scripts/sql/audit-super-admin-acls.sql

-- 1) Summary counts.
SELECT
  (SELECT count(*) FROM role_acls WHERE is_super_admin AND deleted_at IS NULL) AS super_role_acls,
  (SELECT count(*) FROM role_acls ra JOIN roles r ON r.id = ra.role_id
     WHERE ra.is_super_admin AND ra.deleted_at IS NULL AND r.name <> 'superadmin') AS super_role_acls_on_non_superadmin_roles,
  (SELECT count(*) FROM user_acls WHERE is_super_admin AND deleted_at IS NULL) AS super_user_acls,
  (SELECT count(DISTINCT u.id)
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.deleted_at IS NULL
     LEFT JOIN role_acls ra ON ra.role_id = ur.role_id AND ra.tenant_id = u.tenant_id AND ra.deleted_at IS NULL AND ra.is_super_admin
     LEFT JOIN user_acls ua ON ua.user_id = u.id AND ua.deleted_at IS NULL AND ua.is_super_admin
     WHERE u.deleted_at IS NULL AND (ra.id IS NOT NULL OR ua.id IS NOT NULL)) AS users_with_super_admin;

-- 2) Every super-admin role ACL, with how many active users hold that role.
SELECT r.name AS role_name, r.tenant_id AS role_tenant, ra.id AS role_acl_id, ra.tenant_id AS acl_tenant,
       ra.created_at, count(DISTINCT u.id) AS active_users
  FROM role_acls ra
  JOIN roles r ON r.id = ra.role_id
  LEFT JOIN user_roles ur ON ur.role_id = r.id AND ur.deleted_at IS NULL
  LEFT JOIN users u ON u.id = ur.user_id AND u.deleted_at IS NULL
 WHERE ra.is_super_admin AND ra.deleted_at IS NULL
 GROUP BY 1, 2, 3, 4, 5
 ORDER BY (r.name = 'superadmin'), r.name;

-- 3) Every user who is effectively super admin, and where it comes from.
--    Emails are encrypted at rest; compare email_hash against
--    sha256(lower(trim(<platform admin email>))) to recognise the operators.
SELECT u.id AS user_id, u.organization_id, o.name AS organization_name, u.email_hash,
       string_agg(DISTINCT 'role:' || r.name, ', ') FILTER (WHERE ra.id IS NOT NULL) AS via_roles,
       bool_or(ua.id IS NOT NULL) AS via_user_acl
  FROM users u
  LEFT JOIN organizations o ON o.id = u.organization_id
  LEFT JOIN user_roles ur ON ur.user_id = u.id AND ur.deleted_at IS NULL
  LEFT JOIN roles r ON r.id = ur.role_id
  LEFT JOIN role_acls ra ON ra.role_id = ur.role_id AND ra.tenant_id = u.tenant_id AND ra.deleted_at IS NULL AND ra.is_super_admin
  LEFT JOIN user_acls ua ON ua.user_id = u.id AND ua.deleted_at IS NULL AND ua.is_super_admin
 WHERE u.deleted_at IS NULL AND (ra.id IS NOT NULL OR ua.id IS NOT NULL)
 GROUP BY u.id, u.organization_id, o.name, u.email_hash
 ORDER BY o.name NULLS FIRST;
