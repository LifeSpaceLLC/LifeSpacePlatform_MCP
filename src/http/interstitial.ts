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

export interface InterstitialOptions {
  clientName: string;      // the registered DCR client name ("Claude", "Cowork", …)
  continueUrl: string;     // GET → redirects into Trust SSO
  cancelUrl: string;       // GET → renders the denied page
  authorizeUrl: string;    // the full original /authorize URL, for the copy button
  origin?: string;         // ClaudeCode 2026-08-06: plain-English "where did this come from"
  label?: string;          // caller-supplied ?label= — UNTRUSTED text, escaped + capped
  tenantHint?: string;     // caller-supplied ?tenant_hint=, resolved to a name where possible
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
  return SHELL('LifeSpace Connect — sign-in requested', `
    <h1>LifeSpace Connect</h1>
    <p class="sub">A tool connection is asking to sign in.</p>
    <div class="who">Requested by: <b>${esc(o.origin ?? 'an unrecognized destination')}</b></div>
    ${said}
    <div class="panel">
      <div class="row"><span class="k">Requesting tool</span><span class="v"><b>${esc(who)}</b></span></div>
      <div class="row"><span class="k">What it gets</span><span class="v">Your LifeSpace tools for <b>one tenant</b>, which you choose after sign-in.</span></div>
      <div class="row"><span class="k">Next step</span><span class="v">Google sign-in, in <b>this</b> browser profile.</span></div>
    </div>
    <a class="btn" href="${esc(o.continueUrl)}">Continue to Google sign-in</a>
    <a class="btn btn-secondary" href="${esc(o.cancelUrl)}">Cancel</a>
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

// The Cancel landing. Deliberately terminal: no redirect back to the client,
// so a refusal can never bounce into another authorize round.
export function renderCancelled(): string {
  return SHELL('Sign-in cancelled', `
    <h1>Sign-in cancelled</h1>
    <p class="sub">Nothing was connected and no access was granted. You can close this tab.</p>
    <p class="note">To try again, start the connection from the tool that asked — or paste the sign-in link into the browser profile you want to use.</p>`);
}
