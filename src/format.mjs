// Turn a captured pick (from picker.js) into a compact markdown block that
// reads well inside a coding agent's prompt.

// Strip control chars / ANSI escapes that could corrupt the terminal prompt.
// Keeps tab/newline/carriage-return (paste-buffer sends as a bracketed block).
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

function table(obj) {
  const keys = Object.keys(obj || {});
  if (!keys.length) return "_(none)_";
  return keys.map((k) => `- \`${k}\`: ${sanitize(obj[k])}`).join("\n");
}

export function formatPick(p) {
  const head =
    `[picked ${p.tagName}` + (p.id ? `#${p.id}` : "") + `] ${p.selector}`;

  const lines = [];
  lines.push(head);
  lines.push("");
  lines.push(`- url: ${sanitize(p.url)}`);
  lines.push(`- box: ${p.box.w}x${p.box.h} @ (${p.box.x}, ${p.box.y})`);
  if (p.classes) lines.push(`- class: ${sanitize(p.classes)}`);
  if (p.role) lines.push(`- role: ${sanitize(p.role)}`);
  if (p.text) lines.push(`- text: ${sanitize(p.text)}`);
  lines.push(`- xpath: ${sanitize(p.xpath)}`);
  lines.push("");
  lines.push("Computed CSS:");
  lines.push(table(p.css));
  lines.push("");
  lines.push("Design tokens (in effect):");
  lines.push(table(p.tokens));
  lines.push("");
  lines.push("DOM:");
  lines.push("```html");
  lines.push(sanitize(p.html));
  lines.push("```");

  return lines.join("\n");
}

export function formatPicks(picks) {
  return picks.map((p) => formatPick(p)).join("\n\n---\n\n");
}

// One-line, prompt-safe instruction pasted into the agent. Points at the file
// holding the full context. No newlines (single-line cmux send won't submit).
export function summaryLine(p, filePath) {
  const sel = sanitize(p.selector).slice(0, 120);
  const tag = p.tagName + (p.id ? `#${p.id}` : "");
  const text = p.text ? ` ("${sanitize(p.text).slice(0, 50)}")` : "";
  return `Selected UI element <${tag}>${text} at ${sel} — full DOM, computed CSS and design tokens in ${filePath}`;
}
