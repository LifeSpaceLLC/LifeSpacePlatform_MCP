// -- ClaudeCode (2026-07-09, G1 security fix): tenant-consent picker for Connect's
// browser OAuth flow. Ports the device-code consent semantics (Trust device.ts,
// commit 3303025) into the OAuth path: after SSO, an ADMIN chooses which tenant
// the connection is for (own tenant + descendants, indented tree, default = own);
// a plain role=user is PINNED to their own tenant (no picker). The chosen tenant
// then flows into the mint (down-scoped there). Before this, the OAuth path
// silently minted at the role's home tenant — for a root admin, root.
import { sql } from './db.js';

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

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

const SHELL = (title: string, body: string) => `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${title}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{background:#fff;border-radius:16px;padding:40px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:460px;width:100%}
h1{font-size:22px;font-weight:600;color:#1a1a1a;margin-bottom:8px}.sub{font-size:14px;color:#666;margin-bottom:20px}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:12px 20px;margin:10px 0 0;border:1px solid #2563eb;border-radius:8px;font-size:15px;font-weight:500;color:#fff;background:#2563eb;cursor:pointer}
label{display:flex;align-items:center;gap:8px;font-size:14px;color:#333;margin:4px 0;cursor:pointer}.muted{font-size:12px;color:#999;margin-top:16px}</style>
</head><body><div class="card">${body}<p class="muted">Powered by LifeSpace Trust</p></div></body></html>`;

export function renderMessage(title: string, msg: string): string {
  return SHELL(title, `<h1>${esc(title)}</h1><p class="sub">${esc(msg)}</p>`);
}

// The admin tenant picker. `consentId` is the opaque server-side handle; the
// identity is never trusted from the client. Radios default to the home tenant.
export function renderConsent(consentId: string, email: string, homeTenant: string, tree: TenantNode[]): string {
  const rows = tree.map((t) => {
    const pad = 8 + t.depth * 20;
    const checked = t.id === homeTenant ? ' checked' : '';
    const typeTag = t.type ? ` <span class="muted">· ${esc(t.type)}</span>` : '';
    return `<label style="padding-left:${pad}px"><input type="radio" name="tenant_id" value="${esc(t.id)}"${checked}> ${esc(t.name)}${typeTag}</label>`;
  }).join('');
  return SHELL('Choose tenant', `
    <h1>Connect to which tenant?</h1>
    <p class="sub">Signed in as <b>${esc(email)}</b>. Pick the tenant this connection should operate in. Choosing a sub-tenant scopes the connection to that tenant only.</p>
    <form method="POST" action="/oauth/consent">
      <input type="hidden" name="consent" value="${esc(consentId)}">
      <div style="max-height:260px;overflow:auto;border:1px solid #eee;border-radius:8px;padding:8px 4px">${rows}</div>
      <button class="btn" type="submit">Approve &amp; connect</button>
    </form>`);
}
