// Render a captured pick (from picker.js): formatHtml builds a standalone HTML
// file written to disk; summaryLine is the one-line reference sent to the agent
// pointing at that file.

// Strip control chars / ANSI escapes that could corrupt the terminal or file.
export function sanitize(s) {
  if (s == null) return "";
  return String(s)
    // strip ANSI/CSI escape sequences
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "")
    // strip control chars except tab (\x09), newline (\x0A), carriage return (\x0D)
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function esc(s) {
  return sanitize(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function rows(obj) {
  const keys = Object.keys(obj || {});
  if (!keys.length) return `<tr><td colspan="2"><em>none</em></td></tr>`;
  return keys.map((k) => `<tr><th>${esc(k)}</th><td>${esc(obj[k])}</td></tr>`).join("\n");
}

function ancestors(list) {
  if (!Array.isArray(list) || !list.length) return "<li><em>none</em></li>";
  return list.map((a) => {
    const tag = esc(a && a.tag);
    const id = a && a.id ? `#${esc(a.id)}` : "";
    const cls = a && a.classes ? `.${esc(String(a.classes)).trim().split(/\s+/).join(".")}` : "";
    const sel = a && a.selector ? ` <span class="sel">${esc(a.selector)}</span>` : "";
    return `<li><code>&lt;${tag}&gt;${id}${cls}</code>${sel}</li>`;
  }).join("\n");
}

// Full standalone HTML document for one pick.
export function formatHtml(p) {
  const tag = p.tagName || "";
  const box = p.boundingBox || {};
  const title = `picked <${esc(tag)}${p.id ? "#" + esc(p.id) : ""}>`;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} - ${esc(p.selector)}</title>
<style>
  :root { color-scheme: light dark; }
  body { font: 14px/1.5 ui-sans-serif, system-ui, sans-serif; margin: 24px; max-width: 960px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: #6b7280; margin: 24px 0 8px; }
  code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
  .meta { display: grid; grid-template-columns: max-content 1fr; gap: 2px 12px; font-size: 13px; }
  .meta dt { color: #6b7280; }
  .meta dd { margin: 0; word-break: break-word; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; vertical-align: top; padding: 3px 8px; border-bottom: 1px solid #e5e7eb33; }
  th { color: #6b7280; font-weight: 600; white-space: nowrap; width: 1%; }
  ol { margin: 0; padding-left: 20px; }
  .sel { color: #6b7280; }
  pre { background: #1118; padding: 12px; border-radius: 8px; overflow: auto; white-space: pre-wrap; word-break: break-word; }
  .comment { background: #f59e0b22; border-left: 3px solid #f59e0b; padding: 8px 12px; border-radius: 4px; }
</style>
</head>
<body>
<h1>${title}</h1>
<div class="sel"><code>${esc(p.selector)}</code></div>

${p.userComment ? `<h2>User note</h2>\n<div class="comment">${esc(p.userComment)}</div>` : ""}

<h2>Details</h2>
<dl class="meta">
  <dt>page url</dt><dd><a href="${esc(p.pageUrl)}">${esc(p.pageUrl)}</a></dd>
  <dt>selector</dt><dd><code>${esc(p.selector)}</code></dd>
  <dt>xpath</dt><dd><code>${esc(p.xpath)}</code></dd>
  <dt>box</dt><dd>${box.w} x ${box.h} @ (${box.x}, ${box.y})</dd>
  ${p.classes ? `<dt>class</dt><dd><code>${esc(p.classes)}</code></dd>` : ""}
  ${p.role ? `<dt>role</dt><dd>${esc(p.role)}</dd>` : ""}
  ${p.visibleText ? `<dt>text</dt><dd>${esc(p.visibleText)}</dd>` : ""}
</dl>

<h2>Parent hierarchy</h2>
<ol>${ancestors(p.parentHierarchy)}</ol>

<h2>Computed styles</h2>
<table>${rows(p.computedStyles)}</table>

<h2>Design tokens (in effect)</h2>
<table>${rows(p.tokens)}</table>

<h2>DOM</h2>
<pre><code>${esc(p.selectedElementHtml)}</code></pre>
</body>
</html>
`;
}

// One-line, prompt-safe instruction pasted into the agent. Points at the HTML
// file holding the full context. No newlines (single-line cmux send won't submit).
export function summaryLine(p, filePath) {
  const sel = sanitize(p.selector).slice(0, 120);
  const tag = (p.tagName || "") + (p.id ? `#${p.id}` : "");
  const text = p.visibleText ? ` ("${sanitize(p.visibleText).slice(0, 50)}")` : "";
  const comment = p.userComment ? ` - user note: "${sanitize(p.userComment).slice(0, 80)}"` : "";
  return sanitize(
    `Selected UI element <${tag}>${text} at ${sel}${comment} - full DOM, computed CSS and design tokens in ${filePath}`
  ).replace(/[\r\n]+/g, " ");
}
