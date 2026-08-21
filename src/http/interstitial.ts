// ClaudeCode 2026-08-06 10:48 AM PDT
// -- ClaudeCode: the "page before the page". A bare Google SSO tab with no
// context is unreadable: it never says which product asked, or which tenant
// wants a token, and on a machine with several Chrome profiles / Google
// accounts it is a coin flip. So /authorize now RENDERS this page first and
// only redirects into Trust's Google SSO when the person clicks Continue.
// No auto-redirect, no meta-refresh, no timers. The OAuth request itself is
// held server-side (the `pending` map keyed by the connect_txn cookie), so
// nothing here can corrupt the OAuth parameters.
import { SHELL, esc } from './ui.js';
// ClaudeCode 2026-08-19 12:40 PM PDT — the verified block is rendered from a
// RegistrationSummary: server records only (the registration row, the tenant
// name, Trust's seat list). See registrations.ts for where each field comes from.
import type { RegistrationSummary } from './registrations.js';

export interface InterstitialOptions {
  clientName: string;      // the registered DCR client name ("Claude", "Cowork", …)
  continueUrl: string;     // GET → redirects into Trust SSO
  cancelUrl: string;       // GET → renders the denied page
  authorizeUrl: string;    // the full original /authorize URL, for the copy button
  origin?: string;         // ClaudeCode 2026-08-06: plain-English "where did this come from"
  label?: string;          // caller-supplied ?label= — UNTRUSTED text, escaped + capped
  tenantHint?: string;     // caller-supplied ?tenant_hint=, resolved to a name where possible
  // ClaudeCode 2026-08-19 12:40 PM PDT — the VERIFIED half of the page. Present
  // when the client reached us through a per-registration resource URL
  // (`/mcp/r/<id>` → `/authorize/r/<id>`). Absent = a legacy unregistered
  // connection, which still works but is called out in red.
  summary?: RegistrationSummary;
}

// How each validity state reads on the page, and whether Continue is allowed.
// Anything that is not `active` refuses Continue — a revoked or expired
// registration must not be signable-in, and an id we have no record of must not
// be presented as if it meant something.
export function statusCopy(status: RegistrationSummary['status']): { label: string; blurb: string; ok: boolean } {
  switch (status) {
    case 'active':
      return { label: 'Active', blurb: 'This connection registration is active.', ok: true };
    case 'revoked':
      return { label: 'REVOKED', blurb: 'This connection was revoked. Ask an administrator for a new link.', ok: false };
    case 'expired':
      return { label: 'EXPIRED', blurb: 'This connection has expired. Ask an administrator for a new link.', ok: false };
    default:
      return { label: 'UNKNOWN', blurb: "This connection isn't registered — the tenant is chosen after sign-in.", ok: false };
  }
}

// ClaudeCode 2026-08-21 — the roster is GONE. A registration names ONE person
// (`intended_email`), so the page says which account to use and stops. It used to
// render `seats` — every address holding a seat on the tenant — which on a real
// client tenant is six addresses, five of them irrelevant to the person reading.
// `seats` survives in the JSON summary for administrators; no page renders it.
/** Line 2 of the page: the ONE account to sign in with. */
export function signInLine(s: RegistrationSummary): string {
  if (s.intended_email) return `Sign in with <b>${esc(s.intended_email)}</b>.`;
  return `Sign in with an account that has a seat on <b>${esc(s.tenant?.name ?? 'this tenant')}</b>.`;
}

/** Line 1 of the page: what wants to connect, and to what. */
export function connectLine(s: RegistrationSummary): string {
  const what = s.session_label?.trim() || s.folder_label?.trim() || 'A tool';
  return `<b>${esc(what)}</b> wants to connect to <b>${esc(s.tenant?.name ?? 'LifeSpace')}</b>.`;
}

// ClaudeCode 2026-08-06 11:18 AM PDT — the OAuth request carries no session
// identity, but the redirect_uri does say where the callback lands, and that is
// the one honest origin signal available. A loopback address means the asking
// program is on this machine; claude.ai means the web app. Everything else is
// reported as the bare host — no guessing, no dressing it up.
export function describeOrigin(redirectUri: string): string {
  let u: URL;
  try { u = new URL(redirectUri); } catch { return 'an unrecognized destination'; }
  const host = u.hostname.toLowerCase();
  if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]') {
    const port = u.port || (u.protocol === 'https:' ? '443' : '80');
    return `a local program on this computer (port ${port})`;
  }
  if (host === 'claude.ai' || host.endsWith('.claude.ai')) return 'claude.ai';
  return host;
}

// Caller-supplied strings are attacker-controllable: they are escaped as TEXT by
// the shell's esc() (never interpolated as markup) and capped so a long value
// cannot push the real content off the page.
export function clean(v: string | undefined, max: number): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.replace(/[\u0000-\u001f\u007f]/g, ' ').trim(); // control chars → space
  if (!s) return undefined;
  return s.length > max ? `${s.slice(0, max)}…` : s;
}
export const LABEL_MAX = 120;
export const HINT_MAX = 80;

// ClaudeCode 2026-08-21 — THREE LINES AND A BUTTON.
//
// The 08-19 page stated everything it knew: a verified block with session /
// folder / tenant / seat roster / validity, an origin line, the caller's
// unverified claims, a "requesting tool / what it gets / next step" panel, a
// copy-link panel, and a footnote about the unverified convention. All of it
// true, none of it read. A person standing in front of this page has exactly one
// decision to make — click Continue, in this browser profile, or go get the right
// profile — and every extra line made that decision slower.
//
// So the page is now:
//     <label> wants to connect to <tenant>.
//     Sign in with <intended_email>.
//     [ Continue with Google ]
//     Wrong browser? Copy this link and open it there.   (small, grey, below)
//
// Nothing verified-vs-unverified is rendered any more, because nothing
// caller-supplied is rendered any more: `label` and `tenant_hint` are dropped
// from the page entirely (they are still parsed and still preselect a radio in
// the tenant picker — they simply have no place on a page this short). That is
// strictly safer than showing them with a badge nobody read.
export function renderInterstitial(o: InterstitialOptions): string {
  const summary = o.summary;
  const st = summary ? statusCopy(summary.status) : undefined;
  const canContinue = !summary || st!.ok;

  // Line 1 + line 2. A registered connection names its session and its person; a
  // legacy one cannot, and says so in a single red line instead.
  const line1 = summary && summary.status !== 'unknown'
    ? connectLine(summary)
    : 'An app wants to connect to LifeSpace.';
  const line2 = summary && summary.status !== 'unknown'
    ? signInLine(summary)
    : 'Sign in with your LifeSpace account.';
  const notice = !summary || summary.status === 'unknown'
    ? '<p class="stop">This connection isn\'t registered — the tenant is chosen after sign-in.</p>'
    : st!.ok
      ? ''
      : `<p class="stop">${esc(st!.blurb)}</p>`;

  const button = canContinue
    ? `<a class="btn" href="${esc(o.continueUrl)}">Continue with Google</a>`
    : '<span class="btn btn-disabled" aria-disabled="true">Continue with Google</span>';

  return SHELL('LifeSpace Connect', `
    <p class="line">${line1}</p>
    <p class="line">${line2}</p>
    ${notice}
    ${button}
    <p class="footer-line"><a href="#" id="copybtn" class="copy">Wrong browser? Copy this link and open it there.</a></p>
    <input id="authurl" class="offscreen" type="text" readonly value="${esc(o.authorizeUrl)}">
    <script>
      // Copy only — no redirects, no other scripting on this page. The link is a
      // small grey footer BELOW the button (Greg, 2026-08-21): at line size it
      // read as "you are in the wrong browser" rather than an escape hatch.
      document.getElementById('copybtn').addEventListener('click', function (e) {
        e.preventDefault();
        var box = document.getElementById('authurl');
        var btn = document.getElementById('copybtn');
        var done = function () { btn.textContent = 'Link copied — open it in the right browser.'; };
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(box.value).then(done, function(){ box.select(); document.execCommand('copy'); done(); }); }
        else { box.select(); box.setSelectionRange(0, 99999); document.execCommand('copy'); done(); }
      });
    </script>`);
}

// The Cancel landing. Deliberately terminal: no redirect back to the client,
// so a refusal can never bounce into another authorize round.
export function renderCancelled(): string {
  return SHELL('Sign-in cancelled', `
    <h1>Sign-in cancelled</h1>
    <p class="sub">Nothing was connected and no access was granted. You can close this tab.</p>
    <p class="note">To try again, start the connection from the tool that asked — or paste the sign-in link into the browser profile you want to use.</p>`);
}


// ClaudeCode 2026-08-19 12:52 PM PDT — the POST-SIGN-IN HARD STOP. A registered
// connection is LOCKED to its tenant, so when the account that just signed in
// holds no seat there the only honest outcome is to name both and stop. The old
// behaviour — fall through to whatever tenant that identity did have — is exactly
// how a family session ended up writing into a client tenant on 08-06. No auth
// code is issued on this path, and like the Cancel landing it is deliberately
// terminal: a refusal must not bounce into another authorize round.
export function renderSeatRefused(o: {
  email: string;
  tenantName: string;
  intendedEmail: string | null;
  /** Where "Try again" goes — the registration's own sign-in URL. */
  retryUrl?: string;
}): string {
  // ClaudeCode 2026-08-21 — two lines and a button, same as the sign-in page. The
  // 08-19 version listed every account holding a seat on the tenant; the person
  // reading it needs exactly one address, and the registration names it.
  const use = o.intendedEmail
    ? `Sign in with <b>${esc(o.intendedEmail)}</b>.`
    : `Sign in with an account that has a seat on <b>${esc(o.tenantName)}</b>.`;
  return SHELL('Wrong account', `
    <p class="line">That's not the right account.</p>
    <p class="line">${use}</p>
    ${o.retryUrl ? `<a class="btn" href="${esc(o.retryUrl)}">Try again</a>` : ''}`);
}
