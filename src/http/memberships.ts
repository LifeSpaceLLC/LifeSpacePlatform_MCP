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
import { getSubtreeTree, getAncestorIds, type TenantNode } from './tenants.js';

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
  const appId = connectAppId();
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


// ---------------------------------------------------------------------------
// ClaudeCode 2026-08-21 — THE SEAT DEFINITION.
//
// WHY THIS EXISTS (the 2026-08-20 false hard-stop). Connect had THREE different
// answers to "does this person hold a seat on this tenant?":
//
//   1. the sign-in page   → registrations.seatsForTenant(): rows on that tenant,
//                            for CONNECT_TRUST_APP_ID only.
//   2. the sign-in guard  → `buildChoices(resolveMemberships(email))` then
//                            `.some(t => t.id === reg.tenantId)` — Connect app only,
//                            and subject to resolveMemberships' exact-beats-wildcard
//                            COLLAPSE, which discards every `*@domain` grant the
//                            moment the identity holds any exact row.
//   3. Trust             → the door that had already let the person in.
//
// (3) is the authority, and Connect was STRICTER than it. Trust settled this
// twice, and Connect tracked neither:
//
//   * Trust 44052d6 (PR #13, 2026-08-13) "one seat ledger": onboarding a human in
//     Admin writes a row on the LifeSpace PLATFORM app, so Connect sign-in
//     inherits the Platform seat when it has no Connect row of its own.
//   * Trust da184d7 (2026-08-21) went further, after Greg hit this same refusal on
//     the device-link page: the gate is `seatOnTenant(email, tenant)` — ANY
//     trust_app_roles row on that tenant (exact address or matching `*@domain`),
//     across ANY app, plus admin/super_admin on an ANCESTOR. Greg's own words:
//     "a seat is a property of the tenant, not of one app; Greg's CS grant arrives
//     through four different apps."
//
// So the rule below is Trust's `seatOnTenant`, ported. A door that Trust has
// already opened must not be closed again downstream by a narrower copy of the
// same question — that drift is what produced this bug, and the 08-13 mint/login
// split, and the 08-21 device-link refusal. Deliberately NOT the narrower
// "Connect app OR Platform app" pair: someone whose grant on the tenant arrives
// through WP-Designer or CS Designer passes Trust's device gate, and would be
// refused here for no reason anyone could explain.
//
//   A person holds a seat on tenant T when they hold a trust_app_roles row on T
//   itself — matched by exact address or by a `*@domain` grant, at ANY role, on
//   ANY app — or an admin / super_admin row (exact or domain) on ANY ancestor of T.
//
// No app filter, no collapse, no ordering, no silent empty answer. Note that this
// removes the seat check's dependence on CONNECT_TRUST_APP_ID entirely, and with
// it the failure mode where a missing env var read as a confident accusation.

/** The Connect Trust app id. Throws rather than returning "nothing" — a missing
 *  app id must never be indistinguishable from "this person has no access". */
export function connectAppId(): string {
  const appId = process.env.CONNECT_TRUST_APP_ID;
  if (!appId) throw new Error('CONNECT_TRUST_APP_ID is not configured — cannot evaluate seats');
  return appId;
}

/** One trust_app_roles row, reduced to the fields the seat rule reads. `appId` is
 *  carried for ROLE DISPLAY precedence only — the seat test itself ignores it. */
export interface SeatRow {
  email: string;
  role: string;
  tenantId: string;
  appId?: string;
}

/** The seat rule itself — pure, so it can be unit-tested without a database. */
export function holdsSeat(
  rows: SeatRow[],
  email: string,
  tenantId: string,
  ancestorIds: Set<string>,
): boolean {
  const lower = email.trim().toLowerCase();
  const domain = lower.split('@')[1];
  const wildcard = domain ? `*@${domain}` : null;
  for (const r of rows) {
    const e = (r.email ?? '').trim().toLowerCase();
    if (e !== lower && (wildcard === null || e !== wildcard)) continue;
    // A row ON the tenant is a seat at any role.
    if (r.tenantId === tenantId) return true;
    // An admin row ABOVE the tenant reaches down into it.
    if (grantsSubtreeReach(r.role) && ancestorIds.has(r.tenantId)) return true;
  }
  return false;
}

/** Every row this address could match, across EVERY app — exact or `*@domain`. */
export type SeatRowLoader = (email: string) => Promise<SeatRow[]>;

async function dbSeatRows(email: string): Promise<SeatRow[]> {
  const lower = email.trim().toLowerCase();
  const domain = lower.split('@')[1];
  const rows = await sql`
    SELECT email, role, tenant_id::text AS tenant_id, app_id::text AS app_id
      FROM trust_app_roles
     WHERE lower(email) IN (${lower}, ${domain ? `*@${domain}` : lower})
       AND tenant_id IS NOT NULL
  `;
  return rows.map((r) => ({
    email: r.email as string,
    role: (r.role as string) ?? 'user',
    tenantId: r.tenant_id as string,
    appId: (r.app_id as string) ?? undefined,
  }));
}

let seatRowLoader: SeatRowLoader = dbSeatRows;
export function setSeatRowLoader(fn: SeatRowLoader): void {
  seatRowLoader = fn;
}

/** THE seat check used by the registered-connection sign-in guard. Throws on a
 *  lookup failure — the caller renders "we could not check", never "no seat". */
export async function hasSeatOnTenant(email: string, tenantId: string): Promise<boolean> {
  const [rows, ancestors] = await Promise.all([
    seatRowLoader(email),
    getAncestorIds(tenantId),
  ]);
  return holdsSeat(rows, email, tenantId, ancestors);
}

/** The role this address holds on this tenant, by the SAME rule — for the page's
 *  "Sign in with <address>" line and the summary's `intended_role`.
 *  `undefined` = no seat.
 *
 *  PRECEDENCE mirrors Trust's own (role-resolution.ts): an explicit CONNECT row
 *  wins outright, then the PLATFORM row Connect inherits from, then any other
 *  app; within a tier, highest privilege. That is what the person actually
 *  receives at mint, so it is what the page should name — a deliberately narrower
 *  Connect seat must not be displayed as the broader Platform one. */
export function roleFromRows(
  rows: SeatRow[],
  email: string,
  tenantId: string,
  ancestorIds: Set<string>,
): string | undefined {
  const lower = email.trim().toLowerCase();
  const domain = lower.split('@')[1];
  const wildcard = domain ? `*@${domain}` : null;
  const CONNECT = process.env.CONNECT_TRUST_APP_ID ?? '';
  const PLATFORM = process.env.PLATFORM_TRUST_APP_ID ?? 'f0fdabce-2f34-4671-971e-50041f2297c8';
  const appTier = (a?: string) => (a && a === CONNECT ? 0 : a === PLATFORM ? 1 : 2);
  const roleRank = (r: string) => (r === 'super_admin' ? 0 : r === 'admin' ? 1 : 2);

  let best: SeatRow | undefined;
  for (const r of rows) {
    const e = (r.email ?? '').trim().toLowerCase();
    if (e !== lower && (wildcard === null || e !== wildcard)) continue;
    const on = r.tenantId === tenantId;
    const above = grantsSubtreeReach(r.role) && ancestorIds.has(r.tenantId);
    if (!on && !above) continue;
    // A DIRECT row on the tenant always beats reaching down from an ancestor.
    if (best) {
      const bOn = best.tenantId === tenantId;
      if (bOn !== on) { if (!on) continue; }
      else if (appTier(best.appId) !== appTier(r.appId)) { if (appTier(r.appId) > appTier(best.appId)) continue; }
      else if (roleRank(r.role) >= roleRank(best.role)) continue;
    }
    best = r;
  }
  return best?.role;
}

export async function roleOnTenant(email: string, tenantId: string): Promise<string | undefined> {
  const [rows, ancestors] = await Promise.all([
    seatRowLoader(email),
    getAncestorIds(tenantId),
  ]);
  return roleFromRows(rows, email, tenantId, ancestors);
}
