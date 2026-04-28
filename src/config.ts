// -- ClaudeCode: LSP service config — URLs + per-service env var names for personal-mode auth.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export type ServiceId =
  | 'dispatch'
  | 'keys'
  | 'memory'
  | 'knowledge'
  | 'projects'
  | 'library'
  | 'tenant'
  | 'trust'
  | 'handoff'
  | 'promote'
  | 'capture'
  | 'canvas';

export interface ServiceConfig {
  url: string;
  /** Env var name for personal-mode admin API key (read from {Service}/.env). */
  personalEnvVar: string;
  /** Directory name within the LifeSpacePlatform repo (for reading .env). */
  repoDir: string;
  /** Whether this service is currently deployed. Scaffolded-only services are flagged. */
  deployed: boolean;
}

export const SERVICES: Record<ServiceId, ServiceConfig> = {
  dispatch: {
    url: 'https://dispatch.lifespace.com',
    personalEnvVar: 'DISPATCH_ADMIN_API_KEY',
    repoDir: 'Dispatch',
    deployed: true,
  },
  keys: {
    url: 'https://keys.lifespace.com',
    personalEnvVar: 'KEYS_ADMIN_API_KEY',
    repoDir: 'Keys',
    deployed: true,
  },
  memory: {
    url: 'https://memory.lifespace.com',
    personalEnvVar: 'MEMORY_ADMIN_API_KEY',
    repoDir: 'Memory',
    deployed: true,
  },
  knowledge: {
    url: 'https://knowledge.lifespace.com',
    personalEnvVar: 'KNOWLEDGE_ADMIN_API_KEY',
    repoDir: 'Knowledge',
    deployed: true,
  },
  projects: {
    url: 'https://projects.lifespace.com',
    personalEnvVar: 'PROJECTS_ADMIN_API_KEY',
    repoDir: 'Projects',
    deployed: true,
  },
  library: {
    url: 'https://library.lifespace.com',
    personalEnvVar: 'LIBRARY_ADMIN_API_KEY',
    repoDir: 'Library',
    deployed: true,
  },
  tenant: {
    url: 'https://tenant.lifespace.com',
    personalEnvVar: 'TENANT_ADMIN_API_KEY',
    repoDir: 'Tenant',
    deployed: true,
  },
  trust: {
    url: 'https://trust.lifespace.com',
    personalEnvVar: 'TRUST_ADMIN_API_KEY',
    repoDir: 'Trust',
    deployed: true,
  },
  handoff: {
    url: 'https://handoff.lifespace.com',
    personalEnvVar: 'HANDOFF_ADMIN_API_KEY',
    repoDir: 'Handoff',
    deployed: true,
  },
  promote: {
    url: 'https://promote.lifespace.com',
    personalEnvVar: 'PROMOTE_ADMIN_API_KEY',
    repoDir: 'Promote',
    deployed: true,
  },
  capture: {
    url: 'https://capture.lifespace.com',
    personalEnvVar: 'CAPTURE_ADMIN_API_KEY',
    repoDir: 'Capture',
    deployed: true,
  },
  canvas: {
    url: 'https://canvas.lifespace.com',
    personalEnvVar: 'CANVAS_ADMIN_API_KEY',
    repoDir: 'Canvas',
    deployed: true,
  },
};

const envFileCache = new Map<string, Record<string, string>>();

function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

function loadRepoEnv(repoDir: string): Record<string, string> {
  const repoPath = process.env.LSP_REPO_PATH;
  if (!repoPath) return {};
  const cacheKey = `${repoPath}:${repoDir}`;
  const hit = envFileCache.get(cacheKey);
  if (hit) return hit;
  const envPath = join(repoPath, repoDir, '.env');
  if (!existsSync(envPath)) {
    envFileCache.set(cacheKey, {});
    return {};
  }
  const parsed = parseDotEnv(readFileSync(envPath, 'utf8'));
  envFileCache.set(cacheKey, parsed);
  return parsed;
}

/**
 * Resolve auth for a given service.
 * Priority:
 * 1. LSP_TOKEN env var (briefing mode — single bearer JWT across all services)
 * 2. Per-service admin API key from process.env (e.g., LSP_DISPATCH_ADMIN_API_KEY)
 * 3. Per-service admin API key read from {LSP_REPO_PATH}/{Service}/.env (personal mode)
 */
export function authFor(service: ServiceId): string {
  if (process.env.LSP_TOKEN) return process.env.LSP_TOKEN;
  const cfg = SERVICES[service];
  const prefixed = process.env[`LSP_${cfg.personalEnvVar}`];
  if (prefixed) return prefixed;
  const direct = process.env[cfg.personalEnvVar];
  if (direct) return direct;
  const repoEnv = loadRepoEnv(cfg.repoDir);
  const fromRepo = repoEnv[cfg.personalEnvVar];
  if (fromRepo) return fromRepo;
  throw new Error(
    `No auth available for ${service}. Set LSP_TOKEN (briefing mode) or ${cfg.personalEnvVar} / LSP_${cfg.personalEnvVar} (personal mode), or set LSP_REPO_PATH to a LifeSpacePlatform checkout containing ${cfg.repoDir}/.env.`,
  );
}
