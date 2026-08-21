// -- ClaudeCode (2026-07-09, G1 security fix): tenant-consent picker for Connect's
// browser OAuth flow. Ports the device-code consent semantics (Trust device.ts,
// commit 3303025) into the OAuth path: after SSO, an ADMIN chooses which tenant
// the connection is for (own tenant + descendants, indented tree, default = own);
// a plain role=user is PINNED to their own tenant (no picker). The chosen tenant
// then flows into the mint (down-scoped there). Before this, the OAuth path
// silently minted at the role's home tenant — for a root admin, root.
import { sql } from './db.js';
// ClaudeCode 2026-08-06 10:50 AM PDT — shell moved to ui.ts so the picker, the
// authorize interstitial and the cancelled page are one visual flow.
import { SHELL, esc } from './ui.js';

export interface TenantNode {
  id: string;
  name: string;
  type: string;
  depth: number;
}

// The signed-in tenant + all descendants, tree order (parent before children),
// with depth for indentation. Same recursive CTE as Trust device.ts getSubtreeTree.
export async function getSubtreeTree(rootId: string): Promise<TenantNode[]> {
  const rows = await sql`
    WITH RECURSIVE tree AS (
      SELECT id, COALESCE(name,'(unnamed)') AS name, COALESCE(type,'') AS type,
             0 AS depth, lpad('0', 6, '0') || COALESCE(name,'') AS path
        FROM ls_global_tenants WHERE id = ${rootId}::uuid
      UNION ALL
      SELECT t.id, COALESCE(t.name,'(unnamed)'), COALESCE(t.type,''),
             tree.depth + 1, tree.path || '/' || COALESCE(t.name,'')
        FROM ls_global_tenants t INNER JOIN tree ON t.parent_id = tree.id
    )
    SELECT id::text AS id, name, type, depth FROM tree ORDER BY path
  `;
  return rows.map((r) => ({ id: r.id as string, name: r.name as string, type: r.type as string, depth: Number(r.depth) }));
}

// Inclusive descendant id set — the same down-scope validator Connect uses as a
// belt before Trust re-validates at mint time.
export async function getSubtreeIds(rootId: string): Promise<Set<string>> {
  const rows = await sql`
    WITH RECURSIVE subtree AS (
      SELECT id FROM ls_global_tenants WHERE id = ${rootId}::uuid
      UNION ALL
      SELECT t.id FROM ls_global_tenants t INNER JOIN subtree s ON t.parent_id = s.id
    )
    SELECT id::text AS id FROM subtree
  `;
  return new Set(rows.map((r) => r.id as string));
}

export async function tenantName(id: string): Promise<string> {
  const rows = await sql`SELECT COALESCE(name,'(unnamed)') AS name FROM ls_global_tenants WHERE id = ${id}::uuid`;
  return (rows[0]?.name as string) ?? id.slice(0, 8);
}

export function renderMessage(title: string, msg: string): string {
  return SHELL(title, `<h1>${esc(title)}</h1><p class="sub">${esc(msg)}</p>`);
}

// The admin tenant picker. `consentId` is the opaque server-side handle; the
// identity is never trusted from the client. Radios default to the home tenant.
// ClaudeCode 2026-08-06 11:32 AM PDT — `selected` is the radio to preselect: the
// home tenant, or the tenant a caller's tenant_hint matched.
//
// HARD RULES (spoofing guard — a caller-supplied hint is untrusted input):
//   1. The list is SERVER TRUTH — it is built from the signed-in identity's own
//      tenant subtree. A hint can never add a row to it.
//   2. A hint may only PRESELECT a row that is already in that list. It never
//      skips this page and never auto-submits it (there is no submit script).
//   3. A hint never influences role, scopes, or modules — those come from Trust
//      at mint time, re-resolved from the identity.
// Preselection is a convenience; the person still chooses and submits.
export function renderConsent(
  consentId: string,
  email: string,
  selected: string,
  tree: TenantNode[],
  clientName?: string,
  label?: string,
  tenantHint?: string,
): string {
  const rows = tree.map((t) => {
    const pad = 8 + t.depth * 20;
    const checked = t.id === selected ? ' checked' : '';
    const typeTag = t.type ? ` <span class="muted">· ${esc(t.type)}</span>` : '';
    return `<label style="padding-left:${pad}px"><input type="radio" name="tenant_id" value="${esc(t.id)}"${checked}> ${esc(t.name)}${typeTag}</label>`;
  }).join('');
  // ClaudeCode 2026-08-06 10:52 AM PDT — the signed-in identity is the thing that
  // goes wrong across several Google accounts and Chrome profiles, so it leads the
  // page in its own block with an explicit way out, not a sentence in the subtitle.
  const tool = clientName?.trim() ? ` for <b>${esc(clientName.trim())}</b>` : '';
  return SHELL('Choose tenant', `
    <h1>Connect to which tenant?</h1>
    <div class="who">Signed in as <b>${esc(email)}</b> — not you? <a href="/oauth/cancel">Cancel</a> and restart in the right browser profile.</div>
    <p class="sub">Pick the tenant this connection${tool} should operate in. Choosing a sub-tenant scopes the connection to that tenant only.</p>
    ${label || tenantHint ? `<div class="claim">
      This request says it is from: ${label ? `<b>${esc(label)}</b>` : '<i>no label given</i>'} — <b>unverified</b><span class="tag">unverified</span>
      ${tenantHint ? `<div>Expects tenant: <b>${esc(tenantHint)}</b> — <b>unverified</b></div>` : ''}
      <p class="note">Supplied by the requesting tool, not verified by LifeSpace. It may highlight an option below; your selection is what counts.</p></div>` : ''}
    <form method="POST" action="/oauth/consent">
      <input type="hidden" name="consent" value="${esc(consentId)}">
      <div style="max-height:260px;overflow:auto;border:1px solid #eee;border-radius:8px;padding:8px 4px">${rows}</div>
      <button class="btn" type="submit">Approve &amp; connect</button>
    </form>
    <a class="btn btn-secondary" href="/oauth/cancel">Cancel</a>`);
}

// ClaudeCode 2026-08-21 — the ANCESTOR chain of a tenant (parents, grandparents,
// … up to the root), EXCLUSIVE of the tenant itself. Used by the one seat
// definition in memberships.ts: an admin row on any tenant above the registered
// one reaches down into it. Previously the same question was answered by walking
// DOWN from every membership (getSubtreeTree per membership) — same answer in the
// happy case, but it forced the seat test to go through buildChoices, which drops
// `*@domain` rows whenever the identity also holds any exact-email row.
export async function getAncestorIds(tenantId: string): Promise<Set<string>> {
  const rows = await sql`
    WITH RECURSIVE up AS (
      SELECT id, parent_id FROM ls_global_tenants WHERE id = ${tenantId}::uuid
      UNION ALL
      SELECT t.id, t.parent_id FROM ls_global_tenants t INNER JOIN up ON t.id = up.parent_id
    )
    SELECT id::text AS id FROM up WHERE id::text <> ${tenantId}
  `;
  return new Set(rows.map((r) => r.id as string));
}
