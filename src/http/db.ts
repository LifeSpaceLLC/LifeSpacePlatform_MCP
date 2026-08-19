// -- ClaudeCode (2026-07-08): LifeSpace Connect DB layer (postgres-js on the
// shared platform Postgres). Three tables per LifeSpace_Connect_Spec D9:
//   ls_connect_clients  — DCR registrations (tenant-LESS: registration precedes
//                         identity; secret HASHED per spec)
//   ls_connect_codes    — issued OAuth auth codes (~60s, single-use) w/ tenant_id
//   ls_connect_tokens   — opaque refresh tokens (30d rolling, hashed) w/ tenant_id
// The idempotent DDL lives here and is applied by scripts/apply-schema (mirrors
// the Skills/Feedback apply-schema pattern: additive-only, safe to re-run).
import crypto from 'node:crypto';
import postgres from 'postgres';

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL environment variable is required');
}

export const sql = postgres(connectionString);

export function sha256(s: string): string {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// -- ClaudeCode: typed jsonb helper. postgres.js `sql.json` wants a JSONValue;
// our payloads are plain JSON-serialisable objects/arrays, so cast once here
// rather than sprinkling `as` at every call site.
export function jsonb(v: unknown): ReturnType<typeof sql.json> {
  return sql.json(v as Parameters<typeof sql.json>[0]);
}

// -- ClaudeCode: Idempotent, additive DDL. Applied via `npm run apply-schema`.
export const DDL: string[] = [
  `CREATE TABLE IF NOT EXISTS ls_connect_clients (
    client_id text PRIMARY KEY,
    client_name text,
    redirect_uris jsonb NOT NULL DEFAULT '[]'::jsonb,
    grant_types jsonb NOT NULL DEFAULT '[]'::jsonb,
    response_types jsonb NOT NULL DEFAULT '[]'::jsonb,
    token_endpoint_auth_method text NOT NULL DEFAULT 'none',
    scope text,
    secret_hash text,
    client_id_issued_at bigint,
    client_secret_expires_at bigint,
    metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,

  `CREATE TABLE IF NOT EXISTS ls_connect_codes (
    code_hash text PRIMARY KEY,
    client_id text NOT NULL,
    tenant_id uuid NOT NULL,
    user_id text NOT NULL,
    user_email text NOT NULL,
    role text NOT NULL,
    modules jsonb NOT NULL DEFAULT '[]'::jsonb,
    pkce_challenge text NOT NULL,
    redirect_uri text NOT NULL,
    client_state text,
    resource text,
    expires_at timestamptz NOT NULL,
    used boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_connect_codes_expires ON ls_connect_codes(expires_at)`,

  `CREATE TABLE IF NOT EXISTS ls_connect_tokens (
    token_hash text PRIMARY KEY,
    client_id text NOT NULL,
    tenant_id uuid NOT NULL,
    user_id text NOT NULL,
    user_email text NOT NULL,
    role text NOT NULL,
    modules jsonb NOT NULL DEFAULT '[]'::jsonb,
    expires_at timestamptz NOT NULL,
    revoked_at timestamptz,
    last_used_at timestamptz,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_connect_tokens_client ON ls_connect_tokens(client_id)`,
  `CREATE INDEX IF NOT EXISTS idx_connect_tokens_user ON ls_connect_tokens(user_id)`,

  // ClaudeCode 2026-08-06 05:33 PM PDT — in-flight OAuth transactions (the held
  // /authorize request + the tenant-picker state). Previously process-local Maps,
  // which the authorize interstitial made fatally fragile: a redeploy or restart
  // during the human's Google sign-in destroyed the transaction and the callback
  // dead-ended with no way to signal the client. See http/txn-store.ts.
  `CREATE TABLE IF NOT EXISTS ls_connect_txns (
    txn_key text PRIMARY KEY,
    kind text NOT NULL,
    payload jsonb NOT NULL,
    expires_at timestamptz NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
  )`,
  `CREATE INDEX IF NOT EXISTS idx_connect_txns_expires ON ls_connect_txns(expires_at)`,

  // ClaudeCode 2026-08-19 12:22 PM PDT — CONNECTION REGISTRATIONS. The row that
  // makes the sign-in page say something VERIFIED. Before this, everything the
  // interstitial could show about "which session / which folder / which tenant"
  // was caller-typed text off the /authorize URL, marked UNVERIFIED — and the
  // standard connector clients (mcp-remote, Claude Code's http transport) build
  // that URL themselves from our metadata, so in practice not even that text
  // arrived ("no label given / Requested by: your computer").
  //
  // A registration is created by a tenant admin (Admin UI / API / onboarding),
  // BEFORE any sign-in, and its id travels in the RESOURCE URL itself
  // (`/mcp/r/<registration_id>`), which the client discovers as OAuth metadata.
  // The id therefore arrives at /authorize structurally, not as a query param
  // anyone can type — which is what makes the page's claims checkable.
  `CREATE TABLE IF NOT EXISTS ls_connect_registrations (
    registration_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id uuid NOT NULL,
    session_label text NOT NULL,
    folder_label text,
    created_by_user text,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz,
    revoked_at timestamptz,
    last_used_at timestamptz
  )`,
  `CREATE INDEX IF NOT EXISTS idx_connect_registrations_tenant ON ls_connect_registrations(tenant_id)`,

  // Additive: which registration a code / token was issued under (audit — spec
  // mechanism #6). NULL = a legacy unregistered connection, which still works.
  `ALTER TABLE ls_connect_codes  ADD COLUMN IF NOT EXISTS registration_id uuid`,
  `ALTER TABLE ls_connect_tokens ADD COLUMN IF NOT EXISTS registration_id uuid`,
];

export async function applySchema(): Promise<void> {
  for (const stmt of DDL) {
    // ClaudeCode 2026-08-19 12:22 PM PDT — also label ALTER TABLE ... ADD COLUMN steps.
    const label = stmt.match(/CREATE (?:TABLE|(?:UNIQUE )?INDEX) IF NOT EXISTS (\S+)/)?.[1]
      ?? stmt.match(/ALTER TABLE\s+(\S+)\s+ADD COLUMN IF NOT EXISTS\s+(\S+)/)?.slice(1, 3).join('.')
      ?? 'stmt';
    process.stdout.write(`→ ${label} ... `);
    await sql.unsafe(stmt);
    process.stdout.write('OK\n');
  }
}
