// ClaudeCode 2026-08-19 01:36 PM PDT
// -- ClaudeCode: the management + summary API for connection registrations.
//
//   GET  /connect/v1/registrations/:id/summary  — PUBLIC, non-secret. The same
//        facts the sign-in page renders, as JSON, so a session can print the
//        verified summary next to the link instead of handing over a bare URL.
//   GET  /connect/v1/registrations              — admin: list this tenant's
//   POST /connect/v1/registrations              — admin: register a connection
//   POST /connect/v1/registrations/:id/revoke   — admin: revoke one
//
// Auth on the three admin routes is a Trust JWT verified locally with Trust's
// public key — the same verification `verifyAccessToken` already does for /mcp.
// Connect mints nothing and asks Trust for nothing here.
import type { Express, Request, Response } from 'express';
import express from 'express';
import jwt from 'jsonwebtoken';
import { trustPublicKey } from './trust.js';
import { getSubtreeIds } from './tenants.js';
import {
  createRegistration, listRegistrations, registrationSummary, revokeRegistration,
  isRegistrationId, resourceUrl, authorizeUrlFor,
} from './registrations.js';

interface Caller {
  email: string;
  tenantId: string;
  role: string;
  isPlatformAdmin: boolean;
}

// Only an admin of a tenant may register or revoke a connection for it — a
// registration is a standing statement about which tenant a folder connects to,
// so it is exactly as privileged as granting a seat.
const ADMIN_ROLES = new Set(['admin', 'super_admin', 'tenant_admin']);

function authenticate(req: Request): Caller | undefined {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return undefined;
  let claims: Record<string, unknown>;
  try {
    claims = jwt.verify(header.slice(7), trustPublicKey(), { algorithms: ['RS256'] }) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const role = typeof claims.role === 'string' ? claims.role : '';
  const scopes = Array.isArray(claims.scopes) ? (claims.scopes as string[]) : [];
  return {
    email: typeof claims.email === 'string' ? claims.email : '',
    tenantId: typeof claims.tenant_id === 'string' ? claims.tenant_id : '',
    role,
    isPlatformAdmin: role === 'super_admin' || scopes.includes('admin'),
  };
}

function requireAdmin(req: Request, res: Response): Caller | undefined {
  const caller = authenticate(req);
  if (!caller) {
    res.status(401).json({ error: 'A LifeSpace access token is required' });
    return undefined;
  }
  if (!ADMIN_ROLES.has(caller.role) && !caller.isPlatformAdmin) {
    res.status(403).json({ error: 'Only a tenant administrator can manage connection registrations' });
    return undefined;
  }
  return caller;
}

/** The tenants this caller may register a connection for: their own tenant and
 *  everything beneath it. A platform admin is still resolved through the same
 *  subtree call — from the LSP root that is the whole tree, which is correct. */
async function callerScope(caller: Caller): Promise<string[]> {
  if (!caller.tenantId) return [];
  const ids = await getSubtreeIds(caller.tenantId);
  return Array.from(ids);
}

function shape(r: Awaited<ReturnType<typeof listRegistrations>>[number]) {
  return {
    registration_id: r.registrationId,
    tenant_id: r.tenantId,
    session_label: r.sessionLabel,
    folder_label: r.folderLabel,
    created_by_user: r.createdByUser,
    created_at: r.createdAt,
    expires_at: r.expiresAt,
    revoked_at: r.revokedAt,
    last_used_at: r.lastUsedAt,
    resource_url: resourceUrl(r.registrationId),
    sign_in_url: authorizeUrlFor(r.registrationId),
  };
}

export function mountRegistrationsApi(app: Express): void {
  const json = express.json();

  // PUBLIC. Non-secret by construction: labels an admin typed, a tenant name,
  // the seat addresses for that tenant, and timestamps. No token, no key, no
  // client secret, and no tenant content. This is what /lsp-auth prints beside
  // the sign-in link so nobody has to click a bare URL to find out what it is.
  app.get('/connect/v1/registrations/:id/summary', async (req, res) => {
    const id = String(req.params.id ?? '');
    if (!isRegistrationId(id)) {
      res.status(400).json({ error: 'Not a registration id' });
      return;
    }
    try {
      res.json(await registrationSummary(id));
    } catch {
      res.status(500).json({ error: 'Could not read the registration' });
    }
  });

  app.get('/connect/v1/registrations', async (req, res) => {
    const caller = requireAdmin(req, res);
    if (!caller) return;
    try {
      const scope = await callerScope(caller);
      res.json({ registrations: (await listRegistrations(scope)).map(shape) });
    } catch {
      res.status(500).json({ error: 'Could not list registrations' });
    }
  });

  app.post('/connect/v1/registrations', json, async (req, res) => {
    const caller = requireAdmin(req, res);
    if (!caller) return;
    // snake_case bodies — platform convention (PREFLIGHT: camelCase silently drops).
    const body = (req.body ?? {}) as Record<string, unknown>;
    const tenantId = typeof body.tenant_id === 'string' && body.tenant_id ? body.tenant_id : caller.tenantId;
    const sessionLabel = typeof body.session_label === 'string' ? body.session_label.trim() : '';
    const folderLabel = typeof body.folder_label === 'string' ? body.folder_label.trim() : '';
    const expiresAt = typeof body.expires_at === 'string' && body.expires_at ? new Date(body.expires_at) : null;

    if (!sessionLabel) {
      res.status(400).json({ error: 'session_label is required — it is what the sign-in page will show' });
      return;
    }
    if (expiresAt && Number.isNaN(expiresAt.getTime())) {
      res.status(400).json({ error: 'expires_at must be an ISO timestamp' });
      return;
    }
    try {
      const scope = await callerScope(caller);
      if (!scope.includes(tenantId)) {
        res.status(403).json({ error: 'You can only register a connection for your own tenant or one beneath it' });
        return;
      }
      const reg = await createRegistration({
        tenantId,
        sessionLabel,
        folderLabel: folderLabel || null,
        createdByUser: caller.email || null,
        expiresAt,
      });
      res.status(201).json(shape(reg));
    } catch {
      res.status(500).json({ error: 'Could not create the registration' });
    }
  });

  app.post('/connect/v1/registrations/:id/revoke', json, async (req, res) => {
    const caller = requireAdmin(req, res);
    if (!caller) return;
    const id = String(req.params.id ?? '');
    if (!isRegistrationId(id)) {
      res.status(400).json({ error: 'Not a registration id' });
      return;
    }
    try {
      const ok = await revokeRegistration(id, await callerScope(caller));
      if (!ok) {
        res.status(404).json({ error: 'No such registration in your tenant' });
        return;
      }
      res.json(await registrationSummary(id));
    } catch {
      res.status(500).json({ error: 'Could not revoke the registration' });
    }
  });
}
