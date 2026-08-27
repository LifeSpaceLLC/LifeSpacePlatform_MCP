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

// ClaudeCode 2026-08-27 10:47 AM PDT — THE HEADLINE. Greg, 2026-08-27, after the
// fourth unexplained tab: "the browser needs to identify itself — it didn't."
// The 08-21 page led with `connectLine` — a sentence whose subject was the
// asking tool and whose tenant name sat mid-line in bold. That reads fine when
// you clicked something a second ago; it reads as nothing at all when the tab
// appeared on its own during a Claude restart. So the tenant is now the first
// thing on the page, at heading size, alone.
/** Headline: the tenant this sign-in connects to, or the absence of one. */
export function tenantHeadline(s: RegistrationSummary | undefined): string {
  const name = s && s.status !== 'unknown' ? s.tenant?.name?.trim() : '';
  if (name) {
    return `<p class="tenantname"><span class="lead">Connecting to</span>${esc(name)}</p>`;
  }
  // An unregistered /mcp connection genuinely cannot know its tenant — the
  // tenant is chosen after sign-in. Saying so LOUDLY is the point: it is the
  // one thing that makes a folder get migrated to a registered address.
  return '<p class="tenantname unnamed"><span class="lead">Connecting to</span>Unnamed connection</p>';
}

/** Line 2: which connection/folder asked. Registered → the labels an admin
 *  typed when the connection was registered (server records). Unregistered →
 *  the DCR client name and the origin derived from the redirect address; never
 *  anything the caller typed about itself. */
export function askedByLine(
  s: RegistrationSummary | undefined,
  clientName: string,
  origin: string | undefined,
): string {
  if (s && s.status !== 'unknown') {
    const session = s.session_label?.trim();
    const folder = s.folder_label?.trim();
    const what = session || folder || 'A registered connection';
    const where = folder && folder !== what ? ` (folder <b>${esc(folder)}</b>)` : '';
    return `Asked by <b>${esc(what)}</b>${where}.`;
  }
  const who = clientName ? esc(clientName) : 'An app';
  const where = origin
    ? (origin.startsWith('a local program') ? ' on this computer' : ` (${esc(origin)})`)
    : '';
  return `Asked by <b>${who}</b>${where} — this connection isn't registered, so it can't name a tenant.`;
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
//
// ClaudeCode 2026-08-27 10:55 AM PDT — SUPERSEDES the line ordering above (the
// three lines themselves stand). The 08-21 page assumed a person who had just
// clicked something. The failure Greg actually hit four times is the opposite:
// a Claude Code restart makes mcp-remote open this page BY ITSELF, in whatever
// browser is frontmost, with no session able to say what it was. So the page now
// leads with the TENANT NAME at heading size and demotes "who asked" to line two.
// This is the SAME code path for the restart case and the /mcp → Authenticate
// case — every sign-in reaches ConnectOAuthProvider.authorize(), registered
// (/authorize/r/<id>) or not — so there is no second page to fix.
export function renderInterstitial(o: InterstitialOptions): string {
  const summary = o.summary;
  const st = summary ? statusCopy(summary.status) : undefined;
  const canContinue = !summary || st!.ok;

  // ClaudeCode 2026-08-27 10:52 AM PDT — headline + two lines + one button.
  // Line order is now: WHO IS THIS FOR (the tenant, big) → WHO ASKED (the
  // registered connection label / folder) → WHICH ACCOUNT. The old line 1 led
  // with the asking tool, which answered the wrong question for a tab nobody
  // clicked. `connectLine` is kept and still exported — it is the sentence form
  // of the same two facts and other callers/tests read it.
  //
  // ClaudeCode 2026-08-21 (Greg: "that is too vague — the name of the desired
  // tenant should be displayed"). An unregistered connection cannot PROVE a
  // tenant, but it can still say who is asking (the DCR client name + where it
  // runs). It must NOT echo what the asker claims (`?tenant_hint=` is untrusted).
  const headline = tenantHeadline(summary);
  const line1 = askedByLine(summary, o.clientName, o.origin);
  const line2 = summary && summary.status !== 'unknown'
    ? signInLine(summary)
    : 'Sign in with your LifeSpace account — the tenant is chosen after sign-in.';
  // The caller-typed `tenant_hint` is deliberately NOT rendered (doctrine, 08-21:
  // nothing an asker can type appears on this page). A tenant is NAMED only on a
  // registered connection — that is what registrations are for.
  const notice = !summary || summary.status === 'unknown'
    ? '<p class="stop">Ask an administrator to register this connection so its sign-in page can name the tenant.</p>'
    : st!.ok
      ? ''
      : `<p class="stop">${esc(st!.blurb)}</p>`;

  const button = canContinue
    ? `<a class="btn" href="${esc(o.continueUrl)}">Continue with Google</a>`
    : '<span class="btn btn-disabled" aria-disabled="true">Continue with Google</span>';

  return SHELL('LifeSpace Connect', `
    ${headline}
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
  // ClaudeCode 2026-08-27 10:58 AM PDT — same headline rule as the sign-in page:
  // the tenant is the first thing read, so "wrong account for WHAT" is answered
  // before the refusal is.
  return SHELL('Wrong account', `
    <p class="tenantname"><span class="lead">Connecting to</span>${esc(o.tenantName)}</p>
    <p class="line">That's not the right account.</p>
    <p class="line">${use}</p>
    ${o.retryUrl ? `<a class="btn" href="${esc(o.retryUrl)}">Try again</a>` : ''}`);
}
