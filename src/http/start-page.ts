// -- ClaudeCode (2026-07-10, order G4): the hosted onboarding start page at
// GET /start — the last mile of the Sarah story. Non-technical teammates never
// type a URL or CLI command from memory: the invite email lands them here,
// they pick their app, and every step has a big copy button.
//
// Tenant-safe: static HTML, zero secrets, zero tenant data. ?app= preselects
// a tab (cowork | claude-desktop | claude-code | codex).

const MCP_URL = 'https://connect.lifespace.com/mcp';
const CLAUDE_CODE_CMD = `claude mcp add --transport http --scope project lsp ${MCP_URL}`;
const CODEX_TOML = `[mcp_servers.lsp]
command = "npx"
args = ["-y", "mcp-remote", "${MCP_URL}"]`;

const APPS = ['cowork', 'claude-desktop', 'claude-code', 'codex'] as const;
export type StartApp = (typeof APPS)[number];

export function normalizeApp(raw: unknown): StartApp {
  const v = String(raw ?? '').toLowerCase();
  return (APPS as readonly string[]).includes(v) ? (v as StartApp) : 'cowork';
}

// One shared step-card builder keeps the four tabs visually identical.
function step(n: number, title: string, body: string): string {
  return `<div class="step"><div class="stepnum">${n}</div><div class="stepbody"><div class="steptitle">${title}</div><div class="steptext">${body}</div></div></div>`;
}

function copyBlock(id: string, value: string, label: string): string {
  return `<div class="copywrap"><pre id="${id}" class="copyval">${value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')}</pre><button class="copybtn" data-copy="${id}" aria-label="${label}">Copy</button></div>`;
}

const GOOGLE_STEP =
  'A browser window opens. Click <b>Sign in with Google</b> and use your <b>work Google account</b> — the same one your team uses for LifeSpace.';
const TENANT_STEP =
  'If you are asked <i>“Connect to which tenant?”</i>, pick your team and continue. Most people never see this screen — it appears only for admins with more than one team.';

// ClaudeCode 2026-08-06 12:02 PM PDT — the sign-in page can say which request it
// is showing, if the caller tells it. Documented honestly: the two params are read
// off the /authorize URL, and standard connector clients (mcp-remote, Claude Code's
// http transport) build that URL themselves from our metadata — they do NOT forward
// query params from the address in .mcp.json. So the practical route is the copy-
// link escape on the sign-in page, plus any caller that builds its own authorize URL.
const LABEL_STEP =
  'The sign-in page can show a note about which connection it belongs to. Add <code>label</code> (free text) and <code>tenant_hint</code> (a team name or id) to the sign-in URL — e.g. <code>…/authorize?…&amp;label=Coach%20Simple%20folder&amp;tenant_hint=Coach%20Simple</code>. The page then reads <i>“This request says it is from: Coach Simple folder — unverified”</i>, and a matching team is preselected in the picker (you still confirm it). ' +
  'Both are shown as <b>unverified</b> because anyone can put text in a URL — they never change what you can access. ' +
  'Easiest way to use them: on the sign-in page click <b>Copy sign-in link</b>, paste it in the browser profile you want, add the two parameters, and open it there. Note that <code>mcp-remote</code> and the built-in connector clients build the sign-in URL themselves, so parameters added to the server URL in <code>.mcp.json</code> are not passed through.';

const TAB_CONTENT: Record<StartApp, { label: string; intro: string; steps: string }> = {
  cowork: {
    label: 'Cowork',
    intro: 'Connect LifeSpace to Cowork — about a minute, no technical steps.',
    steps: [
      step(1, 'Open Cowork settings', 'In Cowork, open <b>Settings → Connectors</b> and click <b>Add connector</b>.'),
      step(2, 'Paste the LifeSpace address', `Paste this URL into the connector form:${copyBlock('cw-url', MCP_URL, 'Copy the connector URL')}`),
      step(3, 'Sign in', GOOGLE_STEP),
      step(4, 'Pick your team (admins only)', TENANT_STEP),
      step(5, 'Done', 'Your LifeSpace tools now appear in Cowork. Try asking: <i>“list my projects”</i>. To switch teams later, remove the connector and add it again — you’ll get the sign-in (and team picker) fresh.'),
    ].join(''),
  },
  'claude-desktop': {
    label: 'Claude Desktop (chat)',
    intro: 'Add LifeSpace as a custom connector in the Claude Desktop chat app.',
    steps: [
      step(1, 'Open connector settings', 'In Claude Desktop, open <b>Settings → Connectors</b> and click <b>Add custom connector</b>.'),
      step(2, 'Name it and paste the address', `Name: <b>LifeSpace</b>. URL:${copyBlock('cd-url', MCP_URL, 'Copy the connector URL')}`),
      step(3, 'Sign in', GOOGLE_STEP),
      step(4, 'Pick your team (admins only)', TENANT_STEP),
      step(5, 'Done', 'LifeSpace tools appear in the chat’s tools menu. Ask Claude to <i>“list my projects”</i> to confirm.'),
    ].join(''),
  },
  'claude-code': {
    label: 'Claude Code',
    intro: 'One command per project folder. In Claude Code, one folder = one tenant.',
    steps: [
      step(1, 'Add the connector to your project', `Open a terminal in your project folder and run:${copyBlock('cc-cmd', CLAUDE_CODE_CMD, 'Copy the command')}This writes a project-scoped <code>.mcp.json</code> — the connection belongs to this folder only.`),
      step(2, 'Authenticate', `Start <code>claude</code>, type ${copyBlock('cc-mcp', '/mcp', 'Copy /mcp')} choose <b>lsp</b>, then <b>Authenticate</b>. ${GOOGLE_STEP}`),
      step(3, 'Pick your team (admins only)', TENANT_STEP),
      step(4, 'Label the sign-in page (optional)', LABEL_STEP),
      step(5, 'Working across teams?', 'Repeat these steps in each project folder. Each folder signs in on its own, so different folders can point at different tenants — that’s the intended pattern, not a workaround.'),
    ].join(''),
  },
  codex: {
    label: 'ChatGPT Codex',
    intro: 'Codex works too — it’s the less-polished path today. Two options, best first.',
    steps: [
      step(1, 'Option A — remote connector (recommended)', `Add this to <code>~/.codex/config.toml</code>:${copyBlock('cx-toml', CODEX_TOML, 'Copy the Codex config')}Restart Codex; the first tool use opens a browser window. ${GOOGLE_STEP}`),
      step(2, 'Pick your team (admins only)', TENANT_STEP),
      step(3, 'Option B — bearer token fallback', `If the remote connector doesn’t work in your Codex build, run ${copyBlock('cx-login', 'lsp login', 'Copy lsp login')} in a terminal (device-code sign-in) and follow its printed instructions to point Codex at the token it stores. This path works everywhere but doesn’t auto-refresh as smoothly — prefer Option A when it works.`),
    ].join(''),
  },
};

export function renderStartPage(preselect: StartApp): string {
  const tabs = APPS.map(
    (a) =>
      `<button class="tab${a === preselect ? ' active' : ''}" data-app="${a}" role="tab" aria-selected="${a === preselect}">${TAB_CONTENT[a].label}</button>`,
  ).join('');
  const panels = APPS.map(
    (a) =>
      `<section class="panel${a === preselect ? ' active' : ''}" data-panel="${a}"><p class="intro">${TAB_CONTENT[a].intro}</p>${TAB_CONTENT[a].steps}</section>`,
  ).join('');

  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect your AI to LifeSpace</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;color:#1a1a1a;min-height:100vh;padding:24px 16px}
.wrap{max-width:640px;margin:0 auto}
.card{background:#fff;border-radius:16px;padding:32px;box-shadow:0 4px 24px rgba(0,0,0,.08)}
h1{font-size:24px;font-weight:600;margin-bottom:6px}
.sub{font-size:15px;color:#666;margin-bottom:22px}
.tabs{display:flex;flex-wrap:wrap;gap:8px;margin-bottom:20px}
.tab{padding:10px 14px;border:1px solid #ddd;border-radius:10px;background:#fafafa;font-size:14px;font-weight:500;color:#444;cursor:pointer;min-height:44px}
.tab.active{background:#2563eb;border-color:#2563eb;color:#fff}
.panel{display:none}.panel.active{display:block}
.intro{font-size:14px;color:#555;margin-bottom:16px}
.step{display:flex;gap:12px;margin-bottom:16px}
.stepnum{flex:none;width:28px;height:28px;border-radius:50%;background:#eef2ff;color:#2563eb;font-weight:600;font-size:14px;display:flex;align-items:center;justify-content:center}
.steptitle{font-weight:600;font-size:15px;margin-bottom:2px}
.steptext{font-size:14px;color:#444;line-height:1.5}
code{background:#f1f5f9;border-radius:4px;padding:1px 5px;font-size:13px}
.copywrap{display:flex;gap:8px;align-items:stretch;margin:8px 0}
.copyval{flex:1;background:#0f172a;color:#e2e8f0;border-radius:8px;padding:10px 12px;font-size:13px;font-family:ui-monospace,SFMono-Regular,Menlo,monospace;overflow-x:auto;white-space:pre}
.copybtn{flex:none;padding:0 16px;border:1px solid #2563eb;border-radius:8px;background:#2563eb;color:#fff;font-size:13px;font-weight:500;cursor:pointer;min-width:64px}
.copybtn.copied{background:#16a34a;border-color:#16a34a}
.muted{font-size:12px;color:#999;margin-top:20px;text-align:center}
.help{font-size:13px;color:#666;margin-top:18px;padding-top:14px;border-top:1px solid #eee}
</style></head><body><div class="wrap"><div class="card">
<h1>Connect your AI to LifeSpace</h1>
<p class="sub">Pick the app you use. You’ll add LifeSpace as a connector, sign in with your work Google account, and your team’s tools appear — nothing to install, no keys to manage.</p>
<div class="tabs" role="tablist">${tabs}</div>
${panels}
<p class="help">Stuck? Reply to the invite email that brought you here — a teammate will get you connected.</p>
<p class="muted">Powered by LifeSpace Trust · nothing on this page is secret</p>
</div></div>
<script>
document.querySelectorAll('.tab').forEach(function(t){t.addEventListener('click',function(){
  document.querySelectorAll('.tab').forEach(function(x){x.classList.remove('active');x.setAttribute('aria-selected','false')});
  document.querySelectorAll('.panel').forEach(function(x){x.classList.remove('active')});
  t.classList.add('active');t.setAttribute('aria-selected','true');
  document.querySelector('.panel[data-panel="'+t.dataset.app+'"]').classList.add('active');
  history.replaceState(null,'','?app='+t.dataset.app);
})});
document.querySelectorAll('.copybtn').forEach(function(b){b.addEventListener('click',function(){
  var el=document.getElementById(b.dataset.copy);var text=el.textContent;
  (navigator.clipboard?navigator.clipboard.writeText(text):Promise.reject()).catch(function(){
    var ta=document.createElement('textarea');ta.value=text;document.body.appendChild(ta);ta.select();document.execCommand('copy');ta.remove();
  }).finally(function(){b.textContent='Copied ✓';b.classList.add('copied');setTimeout(function(){b.textContent='Copy';b.classList.remove('copied')},1600)});
})});
</script></body></html>`;
}
