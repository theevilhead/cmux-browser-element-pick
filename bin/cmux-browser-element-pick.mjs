#!/usr/bin/env node
// cmux-browser-element-pick - click an element in the cmux in-app browser, send it to the
// coding-agent pane. Built entirely on cmux CLI primitives.
//
// Usage:
//   cmux-browser-element-pick [--browser surface:N] [--agent surface:M] [--enter] [--once] [--poll 400]
//
//   --browser  Browser surface to pick from. Default: active/first browser surface.
//   --agent    Terminal surface to paste into. Default: caller terminal, else
//              another terminal in the browser's workspace.
//   --enter    Press Enter after pasting (auto-submit to the agent).
//   --once     Capture a single element, then exit.
//   --poll     Poll interval in ms between non-blocking checks (default 400).

import {
  readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync,
  readdirSync, statSync, unlinkSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  tree, surfaces, browserEval, selfRef, backendName,
  sendText, sendKey, notify, closeSocket,
} from "../src/cmux.mjs";
import { formatHtml, summaryLine } from "../src/format.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PICKER_SRC = readFileSync(join(__dirname, "..", "src", "picker.js"), "utf8");
const OUT_DIR = join(tmpdir(), "cmux-browser-element-pick");

function parseArgs(argv) {
  const a = { submit: true, once: false, poll: 400, browser: null, agent: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--no-enter" || t === "--no-submit") a.submit = false;
    else if (t === "--enter") a.submit = true;
    else if (t === "--once") a.once = true;
    else if (t === "--ref" || t === "--inline") { /* removed; no-op for back-compat */ }
    else if (t === "--poll") a.poll = parseInt(argv[++i], 10) || 400;
    else if (t === "--browser") a.browser = argv[++i];
    else if (t === "--agent") a.agent = argv[++i];
    else if (t === "-h" || t === "--help") { a.help = true; }
  }
  return a;
}

const HELP = `cmux-browser-element-pick - Option+Click a browser element, send it to your coding agent.

  cmux-browser-element-pick init        add a Dock control to ~/.config/cmux/dock.json
  cmux-browser-element-pick [--browser surface:N] [--agent surface:M] [--no-enter] [--once] [--poll 400]

  --browser   browser surface to pick from (default: active/first browser)
  --agent     terminal surface to send to (default: caller / sibling terminal)
  --no-enter  do NOT auto-submit; leave the reference line in the prompt
  --once      capture one element then exit
  --poll      poll interval ms between non-blocking checks (default 400)

Each pick writes the full element context (DOM, computed CSS, design tokens) to
an HTML file under ${OUT_DIR}
and sends the agent a single reference line pointing at it, then submits.
`;

async function resolveTargets(args) {
  const t = await tree();
  const all = surfaces(t);
  const caller = t.caller || {};
  const active = t.active || {};

  // Browser surface.
  let browser = args.browser;
  if (!browser) {
    if (active.is_browser_surface) browser = active.surface_ref;
    else browser = (all.find((s) => s.type === "browser") || {}).ref;
  }
  if (!browser) throw new Error("No browser surface found. Open the cmux browser (Cmd+Shift+L).");

  const browserWs = (all.find((s) => s.ref === browser) || {}).workspace_ref;

  // The surface running THIS driver (Dock section or the launching terminal),
  // in the same id space as the surface refs (socket=UUID via CMUX_SURFACE_ID,
  // CLI=ref via identify.caller). Exclude it so picks never get pasted back
  // into our own pane.
  const self = selfRef(t);
  const AGENT_RE = /claude|codex|opencode|aider|gemini|goose|amp|cline|cursor/i;

  // Agent terminal surface: a terminal that is NOT us, preferring one whose
  // title looks like a coding agent, preferring the browser's workspace.
  let agent = args.agent;
  if (!agent) {
    const terms = all.filter((s) => s.type === "terminal" && s.ref !== self);
    const inWs = terms.filter((s) => s.workspace_ref === browserWs);
    const pick = (list) => (list.find((s) => AGENT_RE.test(s.title || "")) || list[0] || {}).ref;
    agent = pick(inWs) || pick(terms);
  }
  if (!agent) {
    throw new Error(
      "No agent terminal found (only this pane). Open your agent in another " +
      "pane, or pass --agent surface:N."
    );
  }

  return { browser, agent };
}

// One cheap eval per poll cycle: drain queued picks AND report whether the
// picker is still installed (a navigation wipes it). Each eval is ~30ms and
// non-blocking; we sleep between cycles so the page main thread stays free.
// (cmux's browser.wait long-poll holds the WKWebView JS thread for the whole
// timeout, which freezes the page - so we poll instead of blocking.)
const DRAIN = `(() => { const i = window.__cmuxPickerInstalled === true; const d = window.__cmuxPickerDisabled === true; const q = window.__cmuxPicks || []; window.__cmuxPicks = []; return { installed: i, disabled: d, picks: q }; })()`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Keep the pick-file directory bounded: drop files older than maxAgeMs, then cap
// to the newest maxFiles. Covers every "pick-*" file (the .html bundles).
// Each pick writes two files, so the cap is doubled to keep ~200 picks.
function pruneOutDir({ maxAgeMs = 24 * 60 * 60 * 1000, maxFiles = 200 } = {}) {
  try {
    if (!existsSync(OUT_DIR)) return;
    const now = Date.now();
    let kept = [];
    for (const name of readdirSync(OUT_DIR)) {
      if (!name.startsWith("pick-")) continue;
      const p = join(OUT_DIR, name);
      let m;
      try { m = statSync(p).mtimeMs; } catch (_) { continue; }
      if (now - m > maxAgeMs) { try { unlinkSync(p); } catch (_) {} }
      else kept.push({ p, m });
    }
    kept.sort((a, b) => b.m - a.m);
    for (const f of kept.slice(maxFiles)) { try { unlinkSync(f.p); } catch (_) {} }
  } catch (_) { /* best effort */ }
}

// `cmux-browser-element-pick init` - add a Dock control to ~/.config/cmux/dock.json so the
// picker launches from the cmux sidebar. Backs up any existing config first.
function initDock() {
  const dir = join(homedir(), ".config", "cmux");
  const file = join(dir, "dock.json");
  const control = {
    id: "cmux-browser-element-pick",
    title: "Pick element → agent",
    command: "cmux-browser-element-pick",
    height: 160,
  };

  let config = { controls: [] };
  if (existsSync(file)) {
    const bak = `${file}.${Date.now()}.bak`;
    copyFileSync(file, bak);
    process.stdout.write(`Backed up existing dock.json -> ${bak}\n`);
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      if (parsed && typeof parsed === "object") config = parsed;
    } catch (_) {
      process.stdout.write("Existing dock.json was not valid JSON; starting fresh.\n");
    }
  }
  if (!Array.isArray(config.controls)) config.controls = [];
  config.controls = config.controls.filter((c) => c && c.id !== control.id);
  config.controls.push(control);

  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(config, null, 2) + "\n");

  process.stdout.write(
    `Added "Pick element → agent" Dock control to ${file}\n` +
    `Run \`cmux reload-config\` (or restart cmux), then open the control from the Dock.\n` +
    `Open the cmux browser, Option+Click elements, and they land in your agent pane.\n`
  );
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv[0] === "init") { initDock(); return; }

  const args = parseArgs(argv);
  if (args.help) { process.stdout.write(HELP); return; }

  const { browser, agent } = await resolveTargets(args);
  process.stderr.write(`cmux-browser-element-pick: backend=${await backendName()} browser=${browser} agent=${agent}\n`);

  // Install the picker now. The poll loop re-injects it after navigations
  // (avoids addinitscript, which pins a stale snapshot of the script).
  await browserEval(browser, PICKER_SRC);
  await notify("cmux-browser-element-pick ready", `Option+Click elements in ${browser}`);
  process.stderr.write("cmux-browser-element-pick: ready. Option+Click elements in the browser (Ctrl+C to stop).\n");

  let stopping = false;
  const onExit = async () => {
    if (stopping) return;
    stopping = true;
    try { await browserEval(browser, "window.__cmuxPickerInstalled && (window.__cmuxPickerInstalled=false)"); } catch (_) {}
    closeSocket();
    process.exit(0);
  };
  process.on("SIGINT", onExit);
  process.on("SIGTERM", onExit);

  mkdirSync(OUT_DIR, { recursive: true });
  pruneOutDir();

  let count = 0;
  let misses = 0;
  while (!stopping) {
    // One cheap, non-blocking eval: drain picks + check the picker is alive.
    let res;
    try {
      res = await browserEval(browser, DRAIN);
      misses = 0;
    } catch (e) {
      // Browser surface unavailable (closed / navigated away / not a browser).
      if (++misses >= 3) {
        process.stderr.write(`cmux-browser-element-pick: browser gone (${e.message}); exiting.\n`);
        await onExit();
        return;
      }
      await sleep(1000);
      continue;
    }

    const picks = (res && res.picks) || [];
    // Re-arm if a navigation wiped the picker, but NOT if the user pressed Esc
    // to stop it (that sentinel is cleared on navigation, so a new page re-arms).
    if (!(res && res.installed) && !(res && res.disabled)) {
      try { await browserEval(browser, PICKER_SRC); } catch (_) {}
    }
    if (!picks.length) { await sleep(args.poll); continue; }

    for (const p of picks) {
      mkdirSync(OUT_DIR, { recursive: true });
      const ts = Date.now();
      const file = join(OUT_DIR, `pick-${ts}-${count}.html`);
      writeFileSync(file, formatHtml(p));

      // Write the full element context to an HTML file and send the agent a
      // single reference line pointing at it - nothing else.
      await sendText(agent, summaryLine(p, file));
      // Auto-submit it as one message (disable with --no-enter).
      if (args.submit) await sendKey(agent, "enter");
      count++;
      process.stderr.write(`cmux-browser-element-pick: sent ${p.tagName} (${p.selector}) -> ${agent}\n`);
      if (args.once) { await onExit(); return; }
    }
  }
}

main().catch((e) => { process.stderr.write(`cmux-browser-element-pick: ${e.message}\n`); process.exit(1); });
