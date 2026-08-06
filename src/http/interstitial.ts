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
}

export function renderInterstitial(o: InterstitialOptions): string {
  const who = o.clientName?.trim() || 'An unnamed tool';
  return SHELL('LifeSpace Connect — sign-in requested', `
    <h1>LifeSpace Connect</h1>
    <p class="sub">A tool connection is asking to sign in.</p>
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
