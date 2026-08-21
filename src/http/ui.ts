// ClaudeCode 2026-08-06 10:49 AM PDT
// -- ClaudeCode: shared page shell for Connect's browser-facing OAuth pages
// (interstitial, tenant picker, cancelled/denied, error messages). Lifted out of
// tenants.ts so every page in the flow looks like one product. Static markup,
// zero secrets, no external assets.
export const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));

export const SHELL = (title: string, body: string): string => `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>${esc(title)}</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;background:#f5f5f5;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:20px}
.card{background:#fff;border-radius:16px;padding:40px;box-shadow:0 4px 24px rgba(0,0,0,.08);max-width:520px;width:100%}
h1{font-size:22px;font-weight:600;color:#1a1a1a;margin-bottom:8px}.sub{font-size:14px;color:#666;margin-bottom:20px}
.btn{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;padding:12px 20px;margin:10px 0 0;border:1px solid #2563eb;border-radius:8px;font-size:15px;font-weight:500;color:#fff;background:#2563eb;cursor:pointer;text-decoration:none}
.btn-secondary{background:#fff;color:#333;border-color:#d4d4d4}
.panel{border:1px solid #eee;border-radius:10px;padding:14px 16px;margin:0 0 16px}
.panel-quiet{background:#fafafa;margin-top:22px}
.row{display:flex;gap:12px;padding:6px 0;font-size:14px;color:#333}
.k{flex:0 0 130px;color:#888;font-size:13px}.v{flex:1}
.urlbox{width:100%;padding:9px 10px;margin:8px 0 0;border:1px solid #ddd;border-radius:8px;font-size:12px;color:#444;background:#fff;font-family:ui-monospace,SFMono-Regular,Menlo,monospace}
.who{background:#eff6ff;border:1px solid #bfdbfe;border-radius:10px;padding:12px 14px;margin:0 0 16px;font-size:14px;color:#1e3a8a}
/* ClaudeCode 2026-08-06 11:45 AM PDT — verified facts (blue .who / plain .panel)
   must never look like caller-supplied claims. Anything the caller told us about
   itself renders in this amber, dashed, explicitly-labelled block. */
.claim{background:#fffbeb;border:1px dashed #f59e0b;border-radius:10px;padding:12px 14px;margin:0 0 16px;font-size:14px;color:#78350f}
.claim .tag{display:inline-block;background:#f59e0b;color:#fff;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;margin-left:6px;vertical-align:1px}
.claim .note{color:#92400e}
.footnote{font-size:12px;color:#78350f;background:#fffbeb;border-radius:8px;padding:8px 10px;margin-top:18px}
label{display:flex;align-items:center;gap:8px;font-size:14px;color:#333;margin:4px 0;cursor:pointer}
.note{font-size:12px;color:#777;margin-top:8px;line-height:1.5}
.muted{font-size:12px;color:#999;margin-top:16px}
/* ClaudeCode 2026-08-19 12:34 PM PDT — the VERIFIED block. Green + solid + badged,
   deliberately the visual opposite of the amber dashed .claim block: everything in
   here comes from a server record (the connection registration, ls_global_tenants,
   trust_app_roles), never from anything the caller typed. */
.verified{background:#f0fdf4;border:1px solid #86efac;border-radius:10px;padding:14px 16px;margin:0 0 16px;font-size:14px;color:#14532d}
.verified .tag{display:inline-block;background:#16a34a;color:#fff;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;margin-left:6px;vertical-align:1px}
.verified .row{color:#14532d}.verified .k{color:#3f6212}
.verified .note{color:#3f6212}
.seat{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px}
.seat .role{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#3f6212;font-size:12px}
/* Red = this connection is NOT usable, or is not registered at all. */
.danger{background:#fef2f2;border:1px solid #fca5a5;border-radius:10px;padding:14px 16px;margin:0 0 16px;font-size:14px;color:#7f1d1d}
.danger .tag{display:inline-block;background:#dc2626;color:#fff;border-radius:4px;padding:1px 6px;font-size:11px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;margin-left:6px;vertical-align:1px}
.danger .note{color:#991b1b}
/* ClaudeCode 2026-08-21 — the three-line sign-in page. Body copy is the page. */
.line{font-size:17px;line-height:1.6;color:#1a1a1a;margin:0 0 14px}
.copy{color:#2563eb;text-decoration:none}.copy:hover{text-decoration:underline}
.offscreen{position:absolute;left:-9999px;width:1px;height:1px;opacity:0}
.stop{font-size:15px;line-height:1.5;color:#b91c1c;margin:0 0 14px}
.btn[disabled],.btn.btn-disabled{background:#e5e7eb;border-color:#e5e7eb;color:#9ca3af;cursor:not-allowed}</style>
</head><body><div class="card">${body}<p class="muted">Powered by LifeSpace Trust</p></div></body></html>`;
