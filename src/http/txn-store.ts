// ClaudeCode 2026-08-06 05:31 PM PDT
// -- ClaudeCode: DURABLE store for the two short-lived OAuth transactions that
// span a browser round trip:
//   kind 'auth'    — the held /authorize request, keyed by the connect_txn cookie
//   kind 'consent' — the post-SSO tenant-picker state, keyed by the consent id
//
// WHY THIS EXISTS (the 2026-08-06 Connect outage). Both used to live in
// process-local `Map`s. That was defensible while /authorize was a single
// sub-second 302 into Trust — the window was milliseconds wide. The authorize
// interstitial (PR #17/#18) turned that window into a human-paced round trip:
// read the page → click Continue → Google account chooser → password → 2FA →
// back to us. Any redeploy, container restart, sleep/wake or second replica in
// that window destroys the transaction, and the Trust callback then dead-ends on
// connect.lifespace.com with "Sign-in session expired or not found". Worse, the
// client's redirect_uri lived ONLY in that lost entry, so we cannot even bounce
// the error back — the MCP client's loopback listener never sees a single hit,
// which is exactly what was reported.
//
// The fix is to give these transactions the same durability the auth codes have
// always had: a row in the shared Postgres, TTL-bounded and swept. `take()` is a
// single-statement DELETE ... RETURNING, so a transaction can be consumed exactly
// once even with several instances running.
import { sql, jsonb } from './db.js';

export type TxnKind = 'auth' | 'consent';

export interface TxnStore {
  /** Hold a transaction until `expiresAt` (epoch ms). */
  put(key: string, kind: TxnKind, payload: unknown, expiresAt: number): Promise<void>;
  /** Read WITHOUT consuming — used by Continue, which may be re-visited (back button). */
  peek(key: string, kind: TxnKind): Promise<unknown | undefined>;
  /** Read AND consume, atomically. Expired rows never come back. */
  take(key: string, kind: TxnKind): Promise<unknown | undefined>;
  /** Discard (Cancel). Never throws for an unknown key. */
  drop(key: string): Promise<void>;
  /** Live (unexpired) transaction count — the regression probe in flow-check. */
  size(): Promise<number>;
}

// ---------------------------------------------------------------------------
// Postgres — the real one. Table DDL lives with the rest in db.ts.
export class PostgresTxnStore implements TxnStore {
  async put(key: string, kind: TxnKind, payload: unknown, expiresAt: number): Promise<void> {
    // Lazy sweep on write — no cron needed for a table that holds seconds-old rows.
    await sql`DELETE FROM ls_connect_txns WHERE expires_at < now()`;
    await sql`
      INSERT INTO ls_connect_txns (txn_key, kind, payload, expires_at)
      VALUES (${key}, ${kind}, ${jsonb(payload as Record<string, unknown>)}, ${new Date(expiresAt)})
      ON CONFLICT (txn_key) DO UPDATE
        SET kind = EXCLUDED.kind, payload = EXCLUDED.payload, expires_at = EXCLUDED.expires_at
    `;
  }

  async peek(key: string, kind: TxnKind): Promise<unknown | undefined> {
    const rows = await sql`
      SELECT payload FROM ls_connect_txns
       WHERE txn_key = ${key} AND kind = ${kind} AND expires_at > now()
    `;
    return rows[0]?.payload as unknown | undefined;
  }

  async take(key: string, kind: TxnKind): Promise<unknown | undefined> {
    const rows = await sql`
      DELETE FROM ls_connect_txns
       WHERE txn_key = ${key} AND kind = ${kind} AND expires_at > now()
       RETURNING payload
    `;
    return rows[0]?.payload as unknown | undefined;
  }

  async drop(key: string): Promise<void> {
    await sql`DELETE FROM ls_connect_txns WHERE txn_key = ${key}`;
  }

  async size(): Promise<number> {
    const rows = await sql`SELECT count(*)::int AS n FROM ls_connect_txns WHERE expires_at > now()`;
    return Number(rows[0]?.n ?? 0);
  }
}

// ---------------------------------------------------------------------------
// In-memory — TEST ONLY (flow-check runs with no database). It deliberately
// lives OUTSIDE the provider module so a test can build a fresh provider and
// still resolve the transaction, which is what "survives a restart" means here.
export class MemoryTxnStore implements TxnStore {
  private rows = new Map<string, { kind: TxnKind; payload: unknown; expiresAt: number }>();
  async put(key: string, kind: TxnKind, payload: unknown, expiresAt: number): Promise<void> {
    for (const [k, v] of this.rows) if (v.expiresAt < Date.now()) this.rows.delete(k);
    this.rows.set(key, { kind, payload, expiresAt });
  }
  async peek(key: string, kind: TxnKind): Promise<unknown | undefined> {
    const r = this.rows.get(key);
    return r && r.kind === kind && r.expiresAt > Date.now() ? r.payload : undefined;
  }
  async take(key: string, kind: TxnKind): Promise<unknown | undefined> {
    const p = await this.peek(key, kind);
    if (p !== undefined) this.rows.delete(key);
    return p;
  }
  async drop(key: string): Promise<void> {
    this.rows.delete(key);
  }
  async size(): Promise<number> {
    let n = 0;
    for (const v of this.rows.values()) if (v.expiresAt > Date.now()) n += 1;
    return n;
  }
}

// ---------------------------------------------------------------------------
// The active store. Postgres by default; swapped only by the offline flow-check.
let active: TxnStore | undefined;

export function txnStore(): TxnStore {
  if (!active) active = new PostgresTxnStore();
  return active;
}

export function setTxnStore(store: TxnStore): void {
  active = store;
}
