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
];

export async function applySchema(): Promise<void> {
  for (const stmt of DDL) {
    const label = stmt.match(/CREATE (?:TABLE|(?:UNIQUE )?INDEX) IF NOT EXISTS (\S+)/)?.[1] ?? 'stmt';
    process.stdout.write(`→ ${label} ... `);
    await sql.unsafe(stmt);
    process.stdout.write('OK\n');
  }
}
