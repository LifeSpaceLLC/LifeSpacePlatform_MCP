// ClaudeCode 2026-08-19 12:26 PM PDT
// -- ClaudeCode: CONNECTION REGISTRATIONS — the server-side record that lets the
// sign-in page state facts instead of repeating caller-typed text.
//
// WHY THIS EXISTS. The 08-06 interstitial could only show `label` / `tenant_hint`
// off the /authorize URL, correctly marked UNVERIFIED — and connector clients
// (mcp-remote, Claude Code's http transport) build that URL themselves from our
// OAuth metadata, so those params usually never arrived at all. The page read
// "no label given / Requested by: your computer", and a person was expected to
// sign in blind, often in the wrong Chrome profile.
//
// A registration is created BEFORE any sign-in by a tenant admin, and its id
// travels in the RESOURCE URL (`/mcp/r/<registration_id>`) that goes in
// `.mcp.json`. Clients discover the authorization endpoint from that resource's
// metadata, so the id reaches /authorize structurally — nobody typed it. That is
// what makes everything below presentable as VERIFIED.
//
// Everything here is a READ against server records: this table for the
// session/folder/validity, `ls_global_tenants` for the tenant name, and Trust's
// own `trust_app_roles` for who holds a seat. No Trust write path is touched,
// and no caller-supplied string reaches the verified block.
import { sql } from './db.js';
// ClaudeCode 2026-08-21 — the ONE seat definition. The page's "sign in with"
// line and the sign-in guard now read the same rule; see memberships.ts.
import { roleOnTenant } from './memberships.js';

export type RegistrationStatus = 'active' | 'revoked' | 'expired' | 'unknown';

export interface Registration {
  registrationId: string;
  tenantId: string;
  sessionLabel: string;
  folderLabel: string | null;
  createdByUser: string | null;
  /** ClaudeCode 2026-08-21 — the ONE person this connection was registered for.
   *  Display-only guidance: a seat still decides access. Null on rows that
   *  predate the column and had no creator to backfill from. */
  intendedEmail: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
}

/** One person (or domain grant) holding a seat on the registered tenant. This is
 *  the line that lets someone pick the right Chrome profile BEFORE clicking. */
export interface Seat {
  email: string;
  role: string;
  /** 'account' = a specific address; 'domain' = a `*@company.com` wildcard grant. */
  kind: 'account' | 'domain';
}

/** The public, non-secret summary rendered on the sign-in page and returned by
 *  `GET /connect/v1/registrations/:id/summary`. Nothing here is a credential. */
export interface RegistrationSummary {
  registration_id: string;
  status: RegistrationStatus;
  session_label: string | null;
  folder_label: string | null;
  tenant: { id: string; short_id: string; name: string } | null;
  /** The single account the sign-in page names. Never a roster. */
  intended_email: string | null;
  /** That account's role on this tenant, by the seat rule — null if it has none. */
  intended_role: string | null;
  seats: Seat[];
  created_at: string | null;
  created_by: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  last_used_at: string | null;
  resource_url: string;
  sign_in_url: string;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isRegistrationId(v: unknown): v is string {
  return typeof v === 'string' && UUID_RE.test(v);
}

function connectBaseUrl(): string {
  return process.env.CONNECT_BASE_URL ?? 'https://connect.lifespace.com';
}

/** The URL that goes in `.mcp.json` for this registration. */
export function resourceUrl(registrationId: string): string {
  return `${connectBaseUrl()}/mcp/r/${registrationId}`;
}

/** The per-registration authorize endpoint advertised in AS metadata. */
export function authorizeUrlFor(registrationId: string): string {
  return `${connectBaseUrl()}/authorize/r/${registrationId}`;
}

/** The per-registration OAuth issuer (its AS metadata lives at
 *  `/.well-known/oauth-authorization-server/r/<id>` per RFC 8414). */
export function issuerFor(registrationId: string): string {
  return `${connectBaseUrl()}/r/${registrationId}`;
}

/** Pull a registration id out of a `/mcp/r/<id>` resource URL (RFC 8707
 *  `resource`), or out of an `/authorize/r/<id>` path. Returns undefined for
 *  anything else — a malformed id is simply "no registration", never an error. */
export function registrationIdFromPath(pathOrUrl: string | undefined): string | undefined {
  if (!pathOrUrl) return undefined;
  let p = pathOrUrl;
  try {
    p = new URL(pathOrUrl, connectBaseUrl()).pathname;
  } catch {
    /* already a path */
  }
  const m = /^\/(?:mcp|authorize)\/r\/([^/?#]+)/.exec(p.split('?')[0]);
  const id = m?.[1];
  return isRegistrationId(id) ? id.toLowerCase() : undefined;
}

// ---------------------------------------------------------------------------
// Reads

export async function getRegistration(id: string): Promise<Registration | undefined> {
  if (!isRegistrationId(id)) return undefined;
  const rows = await sql`
    SELECT registration_id::text AS registration_id, tenant_id::text AS tenant_id,
           session_label, folder_label, created_by_user, intended_email,
           created_at, expires_at, revoked_at, last_used_at
      FROM ls_connect_registrations
     WHERE registration_id = ${id}::uuid
  `;
  const r = rows[0];
  if (!r) return undefined;
  return {
    registrationId: r.registration_id as string,
    tenantId: r.tenant_id as string,
    sessionLabel: (r.session_label as string) ?? '',
    folderLabel: (r.folder_label as string | null) ?? null,
    createdByUser: (r.created_by_user as string | null) ?? null,
    intendedEmail: (r.intended_email as string | null) ?? null,
    createdAt: iso(r.created_at),
    expiresAt: r.expires_at ? iso(r.expires_at) : null,
    revokedAt: r.revoked_at ? iso(r.revoked_at) : null,
    lastUsedAt: r.last_used_at ? iso(r.last_used_at) : null,
  };
}

/** Validity, decided here so the page, the Continue gate and the API all agree. */
export function statusOf(reg: Registration | undefined): RegistrationStatus {
  if (!reg) return 'unknown';
  if (reg.revokedAt) return 'revoked';
  if (reg.expiresAt && new Date(reg.expiresAt).getTime() <= Date.now()) return 'expired';
  return 'active';
}

/** Who holds a seat on this tenant for the Connect app — read straight from
 *  Trust's `trust_app_roles`, the same table Trust's own roster endpoint reads
 *  and the same one memberships.ts already resolves sign-ins against. Synthetic
 *  agent principals are excluded; `*@domain` wildcard grants are KEPT but marked
 *  as domain grants, because "anyone at this domain" is a real answer to "which
 *  account should I sign in with". */
export async function seatsForTenant(tenantId: string): Promise<Seat[]> {
  const appId = process.env.CONNECT_TRUST_APP_ID;
  if (!appId || !UUID_RE.test(tenantId)) return [];
  const rows = await sql`
    SELECT DISTINCT ON (lower(email)) lower(email) AS email, role
      FROM trust_app_roles
     WHERE app_id = ${appId}::uuid
       AND tenant_id = ${tenantId}
       AND email NOT LIKE '%@agents.internal'
     ORDER BY lower(email),
              CASE role WHEN 'super_admin' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END
  `;
  return rows.map((r) => ({
    email: r.email as string,
    role: (r.role as string) ?? 'user',
    kind: (r.email as string).startsWith('*@') ? ('domain' as const) : ('account' as const),
  }));
}

async function tenantRow(tenantId: string): Promise<{ id: string; name: string } | null> {
  if (!UUID_RE.test(tenantId)) return null;
  const rows = await sql`
    SELECT id::text AS id, COALESCE(name, '(unnamed)') AS name
      FROM ls_global_tenants WHERE id = ${tenantId}::uuid
  `;
  const r = rows[0];
  return r ? { id: r.id as string, name: r.name as string } : null;
}

/** Everything the verified block needs, from server records only. Safe to serve
 *  publicly: labels an admin typed, a tenant name, seat addresses, timestamps.
 *  No token, no key, no client secret, no tenant data beyond the name. */
export async function registrationSummary(id: string): Promise<RegistrationSummary> {
  const reg = await getRegistration(id);
  const status = statusOf(reg);
  const tenant = reg ? await tenantRow(reg.tenantId) : null;
  // Seats are only meaningful for a registration that exists. Don't leak a
  // roster for an id that was never issued.
  const seats = reg ? await seatsForTenant(reg.tenantId) : [];
  // ClaudeCode 2026-08-21 — ONE named account, resolved through the same seat
  // rule the sign-in guard uses. The page used to render `seats` — the whole
  // tenant roster — which answered a question nobody asked ("who else could sign
  // in?") instead of the one that matters ("which account is THIS link for?").
  const intendedEmail = reg?.intendedEmail ?? null;
  const intendedRole = reg && intendedEmail
    ? (await roleOnTenant(intendedEmail, reg.tenantId).catch(() => undefined)) ?? null
    : null;
  return {
    registration_id: id,
    status,
    session_label: reg?.sessionLabel ?? null,
    folder_label: reg?.folderLabel ?? null,
    tenant: reg
      ? { id: reg.tenantId, short_id: reg.tenantId.slice(0, 8), name: tenant?.name ?? '(unknown tenant)' }
      : null,
    intended_email: intendedEmail,
    intended_role: intendedRole,
    seats,
    created_at: reg?.createdAt ?? null,
    created_by: reg?.createdByUser ?? null,
    expires_at: reg?.expiresAt ?? null,
    revoked_at: reg?.revokedAt ?? null,
    last_used_at: reg?.lastUsedAt ?? null,
    resource_url: resourceUrl(id),
    sign_in_url: authorizeUrlFor(id),
  };
}

// ---------------------------------------------------------------------------
// Writes

export interface CreateRegistrationInput {
  tenantId: string;
  sessionLabel: string;
  folderLabel?: string | null;
  createdByUser?: string | null;
  /** Defaults to the creator — a registration always names ONE intended person. */
  intendedEmail?: string | null;
  expiresAt?: Date | null;
}

export async function createRegistration(input: CreateRegistrationInput): Promise<Registration> {
  const rows = await sql`
    INSERT INTO ls_connect_registrations (tenant_id, session_label, folder_label, created_by_user, intended_email, expires_at)
    VALUES (${input.tenantId}::uuid, ${input.sessionLabel}, ${input.folderLabel ?? null},
            ${input.createdByUser ?? null},
            ${(input.intendedEmail ?? input.createdByUser ?? null)},
            ${input.expiresAt ?? null})
    RETURNING registration_id::text AS registration_id, tenant_id::text AS tenant_id,
              session_label, folder_label, created_by_user, intended_email,
              created_at, expires_at, revoked_at, last_used_at
  `;
  const r = rows[0];
  return {
    registrationId: r.registration_id as string,
    tenantId: r.tenant_id as string,
    sessionLabel: r.session_label as string,
    folderLabel: (r.folder_label as string | null) ?? null,
    createdByUser: (r.created_by_user as string | null) ?? null,
    intendedEmail: (r.intended_email as string | null) ?? null,
    createdAt: iso(r.created_at),
    expiresAt: r.expires_at ? iso(r.expires_at) : null,
    revokedAt: null,
    lastUsedAt: null,
  };
}

/** Revoke is idempotent and never un-revokes: the first revocation time stands. */
export async function revokeRegistration(id: string, tenantIds: string[] | 'any'): Promise<boolean> {
  if (!isRegistrationId(id)) return false;
  const rows = tenantIds === 'any'
    ? await sql`UPDATE ls_connect_registrations SET revoked_at = COALESCE(revoked_at, now())
                 WHERE registration_id = ${id}::uuid RETURNING registration_id`
    : await sql`UPDATE ls_connect_registrations SET revoked_at = COALESCE(revoked_at, now())
                 WHERE registration_id = ${id}::uuid AND tenant_id::text = ANY(${tenantIds})
                 RETURNING registration_id`;
  return rows.length > 0;
}

export async function listRegistrations(tenantIds: string[]): Promise<Registration[]> {
  if (tenantIds.length === 0) return [];
  const rows = await sql`
    SELECT registration_id::text AS registration_id, tenant_id::text AS tenant_id,
           session_label, folder_label, created_by_user, intended_email,
           created_at, expires_at, revoked_at, last_used_at
      FROM ls_connect_registrations
     WHERE tenant_id::text = ANY(${tenantIds})
     ORDER BY created_at DESC
  `;
  return rows.map((r) => ({
    registrationId: r.registration_id as string,
    tenantId: r.tenant_id as string,
    sessionLabel: (r.session_label as string) ?? '',
    folderLabel: (r.folder_label as string | null) ?? null,
    createdByUser: (r.created_by_user as string | null) ?? null,
    intendedEmail: (r.intended_email as string | null) ?? null,
    createdAt: iso(r.created_at),
    expiresAt: r.expires_at ? iso(r.expires_at) : null,
    revokedAt: r.revoked_at ? iso(r.revoked_at) : null,
    lastUsedAt: r.last_used_at ? iso(r.last_used_at) : null,
  }));
}

/** Stamped when a token is actually issued under the registration — the "is this
 *  connection still in use?" column in the Admin list. Best-effort by design: a
 *  failure here must never break a sign-in that already succeeded. */
export async function touchRegistration(id: string): Promise<void> {
  if (!isRegistrationId(id)) return;
  try {
    await sql`UPDATE ls_connect_registrations SET last_used_at = now() WHERE registration_id = ${id}::uuid`;
  } catch {
    /* non-fatal */
  }
}

function iso(v: unknown): string {
  return v instanceof Date ? v.toISOString() : String(v);
}
