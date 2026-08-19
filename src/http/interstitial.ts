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
      return { label: 'REVOKED', blurb: 'This connection registration was revoked by an administrator. No token can be issued for it.', ok: false };
    case 'expired':
      return { label: 'EXPIRED', blurb: 'This connection registration has expired. No token can be issued for it.', ok: false };
    default:
      return { label: 'UNKNOWN', blurb: 'No connection registration exists for this address. Nothing about this request can be verified.', ok: false };
  }
}

function fmt(ts: string | null | undefined): string {
  if (!ts) return 'unknown';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'unknown';
  // Fixed, unambiguous, timezone-stamped — this page is read to make a decision.
  return `${d.toISOString().replace('T', ' ').slice(0, 16)} UTC`;
}

// The seat list is the reason this page exists: it tells the person WHICH Google
// account to be signed in as, BEFORE they click into Google in the wrong profile.
function seatLines(s: RegistrationSummary): string {
  if (s.seats.length === 0) {
    return '<div class="note">No account currently holds a seat on this tenant for LifeSpace Connect. Sign-in will be refused until an administrator grants one.</div>';
  }
  return s.seats
    .map((seat) =>
      seat.kind === 'domain'
        ? `<div class="seat">any address ${esc(seat.email.replace(/^\*/, ''))} <span class="role">— ${esc(seat.role)} (domain grant)</span></div>`
        : `<div class="seat">${esc(seat.email)} <span class="role">— ${esc(seat.role)}</span></div>`,
    )
    .join('');
}

// ClaudeCode 2026-08-19 12:44 PM PDT — the verified block. Every value below is
// read from a server record; nothing the caller sent can reach it. That is the
// whole point of the registration: the page can finally answer "which session,
// which tenant, which account, still valid?" without asking the caller.
export function renderVerifiedBlock(s: RegistrationSummary): string {
  const st = statusCopy(s.status);
  if (s.status === 'unknown') {
    // An id WAS presented and we hold no record of it. That is different from a
    // plain legacy connection: something claimed to be a registration and isn't,
    // so this one does not get to continue.
    return `<div class="danger">
      <b>Unregistered connection</b><span class="tag">nothing verified</span>
      <p class="note">${esc(st.blurb)} Do not sign in unless you know exactly which session asked for this. Ask an administrator to register the connection and use the address it gives you.</p>
    </div>`;
  }
  const cls = st.ok ? 'verified' : 'danger';
  const tagText = st.ok ? 'verified' : st.label;
  return `<div class="${cls}">
    <b>Registered connection</b><span class="tag">${esc(tagText)}</span>
    <div class="row"><span class="k">Session</span><span class="v"><b>${esc(s.session_label ?? '(unnamed)')}</b></span></div>
    <div class="row"><span class="k">Folder</span><span class="v">${esc(s.folder_label ?? '(none recorded)')}</span></div>
    <div class="row"><span class="k">Tenant</span><span class="v"><b>${esc(s.tenant?.name ?? '(unknown)')}</b> · ${esc(s.tenant?.short_id ?? '')}</span></div>
    <div class="row"><span class="k">Sign in as</span><span class="v">${seatLines(s)}</span></div>
    <div class="row"><span class="k">Validity</span><span class="v"><b>${esc(st.label)}</b> — issued ${esc(fmt(s.created_at))} by ${esc(s.created_by ?? 'unknown')}${s.expires_at ? ` · expires ${esc(fmt(s.expires_at))}` : ''}${s.revoked_at ? ` · revoked ${esc(fmt(s.revoked_at))}` : ''}</span></div>
    <p class="note">${esc(st.blurb)} These facts come from LifeSpace's own records for this connection — not from the tool that asked.</p>
  </div>`;
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

export function renderInterstitial(o: InterstitialOptions): string {
  const who = o.clientName?.trim() || 'An unnamed tool';
  // ClaudeCode 2026-08-06 11:22 AM PDT — the origin line is derived by US from the
  // redirect_uri and is therefore trustworthy. The label / tenant hint are things
  // the CALLER said about itself: shown under "This request says it is from",
  // never presented as verified fact, and escaped as text.
  // ClaudeCode 2026-08-06 11:47 AM PDT — SPOOFING GUARD. `label` and `tenant_hint`
  // are whatever the caller typed into the URL; anyone can craft them. They are
  // therefore rendered in the amber "claim" block, carry the word UNVERIFIED, and
  // sit visually apart from the server-verified facts above (the client's
  // registered DCR name and the origin we derived from redirect_uri). They also
  // grant nothing: a hint may preselect a radio in the picker, but it can never
  // skip the picker, auto-submit it, or influence scopes/modules.
  const said = o.label || o.tenantHint
    ? `<div class="claim">
      This request says it is from: ${o.label ? `<b>${esc(o.label)}</b>` : '<i>no label given</i>'} — <b>unverified</b><span class="tag">unverified</span>
      ${o.tenantHint ? `<div>Expects tenant: <b>${esc(o.tenantHint)}</b> — <b>unverified</b></div>` : ''}
      <p class="note">The requesting tool supplied this text about itself. LifeSpace cannot verify it, and it grants nothing — the tenant you actually connect to is the one you pick after sign-in.</p>
    </div>`
    : '';
  // ClaudeCode 2026-08-19 12:48 PM PDT — the verified block leads the page, and
  // the caller's own claims are demoted BELOW it. Continue is only offered when
  // the registration is active (or when there is no registration at all — the
  // legacy path, which keeps working so nothing breaks today).
  const summary = o.summary;
  const verified = summary ? renderVerifiedBlock(summary) : renderUnregisteredNotice();
  const st = summary ? statusCopy(summary.status) : undefined;
  const canContinue = !summary || st!.ok;
  const whatItGets = summary && summary.status === 'active'
    ? `Your LifeSpace tools for <b>${esc(summary.tenant?.name ?? 'the registered tenant')}</b> only — this connection is locked to that tenant.`
    : 'Your LifeSpace tools for <b>one tenant</b>, which you choose after sign-in.';
  const continueRow = canContinue
    ? `<a class="btn" href="${esc(o.continueUrl)}">Continue to Google sign-in</a>
    <a class="btn btn-secondary" href="${esc(o.cancelUrl)}">Cancel</a>`
    : `<span class="btn btn-disabled" aria-disabled="true">Continue to Google sign-in</span>
    <p class="note">Continue is disabled because this connection is ${esc(st!.label.toLowerCase())}. Ask an administrator for a current connection address.</p>
    <a class="btn btn-secondary" href="${esc(o.cancelUrl)}">Close</a>`;
  return SHELL('LifeSpace Connect — sign-in requested', `
    <h1>LifeSpace Connect</h1>
    <p class="sub">A tool connection is asking to sign in.</p>
    ${verified}
    <div class="who">Requested by: <b>${esc(o.origin ?? 'an unrecognized destination')}</b></div>
    ${said}
    <div class="panel">
      <div class="row"><span class="k">Requesting tool</span><span class="v"><b>${esc(who)}</b></span></div>
      <div class="row"><span class="k">What it gets</span><span class="v">${whatItGets}</span></div>
      <div class="row"><span class="k">Next step</span><span class="v">Google sign-in, in <b>this</b> browser profile.</span></div>
    </div>
    ${continueRow}
    <div class="panel panel-quiet">
      <div class="k">Wrong browser profile?</div>
      <p class="note">If this window is signed into the wrong Google account, copy this sign-in link and open it in the right Chrome profile — start there instead of here.</p>
      <input id="authurl" class="urlbox" type="text" readonly value="${esc(o.authorizeUrl)}">
      <button class="btn btn-secondary" type="button" id="copybtn">Copy sign-in link</button>
    </div>
    <p class="footnote">Anything this page can't verify is marked unverified.</p>
    <script>
      // Copy button only — no redirects, no other scripting on this page.
      document.getElementById('copybtn').addEventListener('click', function () {
        var box = document.getElementById('authurl');
        box.select(); box.setSelectionRange(0, 99999);
        var done = function () { var b = document.getElementById('copybtn'); b.textContent = 'Copied'; setTimeout(function(){ b.textContent = 'Copy sign-in link'; }, 2000); };
        if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(box.value).then(done, function(){ document.execCommand('copy'); done(); }); }
        else { document.execCommand('copy'); done(); }
      });
    </script>`);
}

// ClaudeCode 2026-08-19 12:26 PM PDT — the LEGACY notice. A sign-in that arrived
// on the plain /mcp + /authorize path carries no registration at all, so there is
// genuinely nothing to verify: no session, no folder, no tenant decided in
// advance, and the tenant picker after sign-in is what decides. It still WORKS —
// nothing in the field breaks today — but it says so in red rather than looking
// like a page that checked something.
export function renderUnregisteredNotice(): string {
  return `<div class="danger">
    <b>Unregistered connection</b><span class="tag">nothing verified</span>
    <p class="note">This connection was not registered in advance, so LifeSpace cannot tell you which session or folder asked for it, or which tenant it is for — you will choose the tenant yourself after signing in. It still works. For a sign-in page that states these facts from LifeSpace's own records, ask an administrator to register the connection and use the address it gives you.</p>
  </div>`;
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
  tenantShortId: string;
  sessionLabel: string;
  seats: { email: string; role: string; kind: 'account' | 'domain' }[];
}): string {
  const who = o.seats.length
    ? `<div class="row"><span class="k">Accounts with a seat</span><span class="v">${o.seats
        .map((s) => (s.kind === 'domain'
          ? `<div class="seat">any address ${esc(s.email.replace(/^\*/, ''))} <span class="role">— ${esc(s.role)}</span></div>`
          : `<div class="seat">${esc(s.email)} <span class="role">— ${esc(s.role)}</span></div>`))
        .join('')}</span></div>`
    : '<div class="row"><span class="k">Accounts with a seat</span><span class="v">none</span></div>';
  return SHELL('No seat on this tenant', `
    <h1>No token was issued</h1>
    <div class="danger">
      <b>Wrong account for this connection</b><span class="tag">stopped</span>
      <p class="note">You signed in as <b>${esc(o.email)}</b>. This connection is registered for tenant <b>${esc(o.tenantName)}</b> (${esc(o.tenantShortId)}), and <b>${esc(o.email)}</b> has no seat there. <b>No token was issued</b> and nothing was connected.</p>
    </div>
    <div class="panel">
      <div class="row"><span class="k">Session</span><span class="v">${esc(o.sessionLabel || '(unnamed)')}</span></div>
      <div class="row"><span class="k">Tenant</span><span class="v"><b>${esc(o.tenantName)}</b> · ${esc(o.tenantShortId)}</span></div>
      ${who}
    </div>
    <p class="note">Start the connection again in a browser profile signed into one of the accounts above, or ask an administrator to grant <b>${esc(o.email)}</b> a seat on ${esc(o.tenantName)}. LifeSpace will never quietly connect you to a different tenant instead.</p>`);
}
