// Server-rendered HTML helpers. All dynamic content MUST go through esc().

export function esc(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const NAV = [
  ['/drafts', 'Drafts'],
  ['/users', 'Users'],
  ['/chats', 'Chats'],
  ['/style', 'Style'],
  ['/settings', 'Settings'],
  ['/integrations', 'Integrations'],
];

export function layout({ title, active, csrf, flash, body }) {
  const nav = NAV.map(
    ([href, label]) =>
      `<a href="${href}" class="nav-link${active === href ? ' active' : ''}">${label}</a>`,
  ).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} · Teams AI Assistant</title>
<style>
:root { --bg:#f4f5f7; --card:#fff; --ink:#1f2328; --muted:#6a7178; --accent:#4f6bed; --ok:#2da44e; --warn:#bf8700; --bad:#cf222e; }
* { box-sizing: border-box; }
body { margin:0; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; background:var(--bg); color:var(--ink); }
header { background:var(--card); border-bottom:1px solid #e1e4e8; padding:0.6rem 1rem; display:flex; align-items:center; gap:1rem; flex-wrap:wrap; position:sticky; top:0; z-index:10; }
header .brand { font-weight:700; margin-right:0.5rem; }
.nav-link { text-decoration:none; color:var(--muted); padding:0.35rem 0.7rem; border-radius:6px; }
.nav-link.active, .nav-link:hover { background:#eef1f6; color:var(--ink); }
main { max-width: 860px; margin: 1rem auto; padding: 0 1rem 3rem; }
.card { background:var(--card); border:1px solid #e1e4e8; border-radius:10px; padding:1rem; margin-bottom:1rem; }
h1 { font-size:1.25rem; } h2 { font-size:1.05rem; }
.muted { color:var(--muted); font-size:0.9rem; }
.btn { display:inline-block; border:1px solid #d0d4da; background:var(--card); color:var(--ink); padding:0.45rem 0.9rem; border-radius:8px; cursor:pointer; font-size:0.92rem; text-decoration:none; }
.btn:hover { background:#f0f2f5; }
.btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
.btn.ok { background:var(--ok); border-color:var(--ok); color:#fff; }
.btn.bad { background:var(--bad); border-color:var(--bad); color:#fff; }
.btn.small { padding:0.25rem 0.6rem; font-size:0.82rem; }
.actions { display:flex; gap:0.5rem; flex-wrap:wrap; margin-top:0.75rem; }
textarea, input[type=text], input[type=password] { width:100%; border:1px solid #d0d4da; border-radius:8px; padding:0.5rem; font:inherit; }
textarea { min-height:5rem; }
label { display:block; font-size:0.85rem; margin:0.6rem 0 0.25rem; color:var(--muted); }
.flash { padding:0.6rem 0.9rem; border-radius:8px; margin-bottom:1rem; }
.flash.ok { background:#e6f4ea; color:#116329; }
.flash.bad { background:#ffebe9; color:#a40e26; }
.msg-bubble { background:#eef1f6; border-radius:8px; padding:0.6rem 0.8rem; margin:0.35rem 0; white-space:pre-wrap; word-break:break-word; }
.reply-bubble { background:#e8f0fe; border-radius:8px; padding:0.6rem 0.8rem; margin:0.35rem 0; white-space:pre-wrap; word-break:break-word; }
.meta { color:var(--muted); font-size:0.85rem; margin-bottom:0.4rem; }
table { width:100%; border-collapse:collapse; font-size:0.92rem; }
th, td { text-align:left; padding:0.4rem 0.5rem; border-bottom:1px solid #eef0f3; vertical-align:top; }
th { color:var(--muted); font-weight:600; font-size:0.8rem; text-transform:uppercase; letter-spacing:0.03em; }
.badge { display:inline-block; padding:0.1rem 0.5rem; border-radius:999px; font-size:0.75rem; font-weight:600; }
.badge.pending { background:#fff3cd; color:#7a5b00; }
.badge.sent { background:#d1f2da; color:#116329; }
.badge.failed, .badge.expired, .badge.rejected { background:#ffe0e0; color:#a40e26; }
.badge.edited { background:#dbe7ff; color:#1c4ed8; }
.badge.sending, .badge.approved { background:#e8e8e8; color:#444; }
.row-actions { white-space:nowrap; }
form.inline { display:inline; }
.login { max-width:380px; margin:4rem auto; }
.topline { display:flex; justify-content:space-between; align-items:center; gap:1rem; flex-wrap:wrap; }
@media (max-width: 600px) { th, td { padding:0.35rem 0.3rem; } .btn { padding:0.4rem 0.7rem; } }
</style>
</head>
<body>
<header>
  <span class="brand">Teams AI Assistant</span>
  <nav>${nav}</nav>
  <form method="post" action="/logout" style="margin-left:auto">
    <input type="hidden" name="_csrf" value="${esc(csrf)}">
    <button class="btn small" type="submit">Log out</button>
  </form>
</header>
<main>
${flash ? `<div class="flash ${flash.type === 'error' ? 'bad' : 'ok'}">${esc(flash.message)}</div>` : ''}
${body}
</main>
</body>
</html>`;
}
