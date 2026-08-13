// ClaudeCode 2026-08-13 02:05 PM PDT
// -- ClaudeCode: the identity's MEMBERSHIPS on the Connect app — every
// trust_app_roles row it holds, not just the one row Trust happened to resolve.
//
// WHY THIS EXISTS (the 2026-08-13 "no tenant picker" bug). Connect built the
// whole post-SSO flow out of a SINGLE tenant: `identity.tenant_id`, the tenant of
// the one role row Trust's SSO exchange picked. That is fine for the common case
// and wrong for anyone who holds more than one role row on the app:
//
//   jon@coachsimple.net holds TWO rows on the Connect app —
//     user @ Coach Simple        (01ecd85f…, 12 modules)
//     user @ Curriculum Rebuild  (4162bcb9…, 12 modules, a CHILD of Coach Simple)
//
// Trust's SSO resolveRole returns exactly one of them (auth.ts orders by role
// rank then row id, so the Curriculum Rebuild row wins), and Connect then
// (a) skipped the picker entirely because the winning row was role=user, and
// (b) had no way to reach the other membership even if it had rendered one — the
// picker's list was `getSubtreeTree(homeTenant)`, and a role=user subtree is just
// their own tenant. Two sibling MEMBERSHIPS could never merge into one list.
//
// So the choice list is built here instead: the UNION of every role row the
// identity holds, plus the descendants of the rows whose role actually grants
// subtree reach (admin/super_admin — the pre-existing admin picker semantics,
// preserved exactly), deduped, tenant NAMES shown.
import { sql } from './db.js';
import { getSubtreeTree, type TenantNode } from './tenants.js';

/** One trust_app_roles row for this identity on the Connect app. */
export interface Membership {
  tenantId: string;
  tenantName: string;
  role: string;
  modules: string[];
}

/** What a chosen tenant actually grants — the CHOSEN row's role + modules, not
 *  whichever row Trust's SSO exchange happened to return. */
export interface Grant {
  tenantId: string;
  role: string;
  modules: string[];
}

export type MembershipResolver = (email: string) => Promise<Membership[]>;

// -- ClaudeCode: mirrors Trust's own resolution ORDER (auth.ts/mint.ts): an exact
// email match wins outright; the *@domain wildcard is consulted only when the
// identity has no exact row of its own. The difference is that this returns ALL
// matching rows instead of silently collapsing to the first one.
async function dbResolveMemberships(email: string): Promise<Membership[]> {
  const lower = email.trim().toLowerCase();
  const appId = process.env.CONNECT_TRUST_APP_ID;
  if (!appId) return [];
  const domain = lower.split('@')[1];

  const rows = await sql`
    SELECT r.tenant_id::text AS tenant_id,
           r.role            AS role,
           COALESCE(r.modules, '{}')          AS modules,
           COALESCE(t.name, '(unnamed)')      AS tenant_name,
           r.email           AS matched_email,
           r.id              AS row_id
      FROM trust_app_roles r
      LEFT JOIN ls_global_tenants t ON t.id::text = r.tenant_id
     WHERE r.app_id = ${appId}::uuid
       AND lower(r.email) IN (${lower}, ${domain ? `*@${domain}` : lower})
       AND r.tenant_id IS NOT NULL
     ORDER BY tenant_name, r.id
  `;

  const exact = rows.filter((r) => String(r.matched_email).toLowerCase() === lower);
  const chosen = exact.length > 0 ? exact : rows;

  const seen = new Set<string>();
  const out: Membership[] = [];
  for (const r of chosen) {
    const tenantId = r.tenant_id as string;
    if (!tenantId || seen.has(tenantId)) continue;
    seen.add(tenantId);
    out.push({
      tenantId,
      tenantName: (r.tenant_name as string) ?? tenantId.slice(0, 8),
      role: r.role as string,
      modules: (r.modules as string[] | null) ?? [],
    });
  }
  return out;
}

// The resolver is swappable so the offline flow-check can exercise the real
// union/choice/grant logic without a database (same seam as txn-store).
let resolver: MembershipResolver = dbResolveMemberships;

export function setMembershipResolver(fn: MembershipResolver): void {
  resolver = fn;
}

export function resolveMemberships(email: string): Promise<Membership[]> {
  return resolver(email);
}

/** Only admin-ish roles reach DOWN the tenant tree. A plain role=user membership
 *  is exactly one tenant — its own. */
export function grantsSubtreeReach(role: string): boolean {
  return role === 'admin' || role === 'super_admin';
}

/** The tenant list the picker offers: the UNION of every membership's tenant plus
 *  the descendants of the memberships that reach down, deduped (first wins, so a
 *  tenant the identity holds directly keeps its own top-level row). */
export async function buildChoices(memberships: Membership[]): Promise<TenantNode[]> {
  const out: TenantNode[] = [];
  const seen = new Set<string>();
  for (const m of memberships) {
    const nodes: TenantNode[] = grantsSubtreeReach(m.role)
      ? await getSubtreeTree(m.tenantId)
      : [{ id: m.tenantId, name: m.tenantName, type: '', depth: 0 }];
    for (const n of nodes) {
      if (seen.has(n.id)) continue;
      seen.add(n.id);
      out.push(n);
    }
  }
  return out;
}

/** ≥2 distinct tenants to choose between → the picker ALWAYS renders, whatever
 *  the role. One (or none) → nothing to choose, don't make anyone click. */
export function pickerNeeded(choices: TenantNode[]): boolean {
  return choices.length > 1;
}

/** What the auth code (and therefore the session) is scoped to. When the chosen
 *  tenant IS one of the identity's own role rows, that row's role + modules are
 *  the grant — this is the half of the bug that survived the missing picker:
 *  Connect used to stamp `identity.role` / `identity.modules` onto the code row
 *  no matter which tenant was chosen, i.e. the OTHER row's modules. When the
 *  chosen tenant is a descendant reached through an admin membership, the grant
 *  is resolved by Trust at mint time (down-scoped there), so we carry the admin
 *  row's role and let the mint narrow it — unchanged behaviour. */
export function resolveGrantForChoice(
  memberships: Membership[],
  chosenTenant: string,
  fallback: { role: string; modules?: string[] | null },
): Grant {
  const own = memberships.find((m) => m.tenantId === chosenTenant);
  if (own) return { tenantId: chosenTenant, role: own.role, modules: own.modules };
  const reaching = memberships.find((m) => grantsSubtreeReach(m.role));
  return {
    tenantId: chosenTenant,
    role: reaching?.role ?? fallback.role,
    modules: reaching ? [] : (fallback.modules ?? []),
  };
}
