#!/usr/bin/env node
// cmux-browser-element-pick — click an element in the cmux in-app browser, send it to the
// coding-agent pane. Built entirely on cmux CLI primitives.
//
// Usage:
//   cmux-browser-element-pick [--browser surface:N] [--agent surface:M] [--enter] [--once] [--poll 250]
//
//   --browser  Browser surface to pick from. Default: active/first browser surface.
//   --agent    Terminal surface to paste into. Default: caller terminal, else
//              another terminal in the browser's workspace.
//   --enter    Press Enter after pasting (auto-submit to the agent).
//   --once     Capture a single element, then exit.
//   --poll     Poll interval in ms (default 250).

import { readFileSync, writeFileSync, mkdirSync, existsSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir, homedir } from "node:os";
import {
  tree, surfaces, browserEval,
  pasteToSurface, sendText, sendKey, notify,
} from "../src/cmux.mjs";
import { formatPick, summaryLine } from "../src/format.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PICKER_SRC = readFileSync(join(__dirname, "..", "src", "picker.js"), "utf8");
const OUT_DIR = join(tmpdir(), "cmux-browser-element-pick");

function parseArgs(argv) {
  const a = { enter: false, once: false, inline: false, poll: 250, browser: null, agent: null };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === "--enter") a.enter = true;
    else if (t === "--once") a.once = true;
    else if (t === "--inline") a.inline = true;
    else if (t === "--poll") a.poll = parseInt(argv[++i], 10) || 250;
    else if (t === "--browser") a.browser = argv[++i];
    else if (t === "--agent") a.agent = argv[++i];
    else if (t === "-h" || t === "--help") { a.help = true; }
  }
  return a;
}

const HELP = `cmux-browser-element-pick — Option+Click a browser element, send it to your coding agent.

  cmux-browser-element-pick init        add a Dock control to ~/.config/cmux/dock.json
  cmux-browser-element-pick [--browser surface:N] [--agent surface:M] [--enter] [--once] [--inline] [--poll 250]

  --browser  browser surface to pick from (default: active/first browser)
  --agent    terminal surface to send to (default: caller / sibling terminal)
  --enter    auto-submit to the agent after sending
  --once     capture one element then exit
  --inline   paste the full block into the prompt instead of a file reference
             (may execute line-by-line in a raw shell; safe in agent TUIs)
  --poll     poll interval ms (default 250)

By default the full DOM/CSS/tokens are written to a file under
${OUT_DIR} and a one-line reference is sent to the agent.
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

  // The surface running THIS driver (Dock section or the launching terminal).
  // caller.surface_ref is the ref form ("surface:N") matching the flattened
  // tree; CMUX_SURFACE_ID is a UUID and would not match. Exclude it so picks
  // never get pasted back into our own CLI.
  const self = caller.surface_ref;
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

const DRAIN = `(() => { const q = window.__cmuxPicks || []; window.__cmuxPicks = []; return q; })()`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// `cmux-browser-element-pick init` — add a Dock control to ~/.config/cmux/dock.json so the
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
  process.stderr.write(`cmux-browser-element-pick: browser=${browser} agent=${agent}\n`);

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
    process.exit(0);
  };
  process.on("SIGINT", onExit);
  process.on("SIGTERM", onExit);

  let count = 0;
  while (!stopping) {
    let picks = [];
    try {
      // Re-inject after a navigation cleared the picker (sticky armed state
      // survives via sessionStorage).
      const present = await browserEval(browser, "window.__cmuxPickerInstalled===true");
      if (!present) await browserEval(browser, PICKER_SRC);
      picks = (await browserEval(browser, DRAIN)) || [];
    } catch (e) { process.stderr.write(`cmux-browser-element-pick: drain error: ${e.message}\n`); }

    for (const p of picks) {
      const block = formatPick(p);
      if (args.inline) {
        await pasteToSurface(agent, block + "\n");
      } else {
        mkdirSync(OUT_DIR, { recursive: true });
        const file = join(OUT_DIR, `pick-${Date.now()}-${count}.md`);
        writeFileSync(file, block + "\n");
        await sendText(agent, summaryLine(p, file));
      }
      if (args.enter) await sendKey(agent, "enter");
      count++;
      process.stderr.write(`cmux-browser-element-pick: sent ${p.tagName} (${p.selector}) -> ${agent}\n`);
      if (args.once) { await onExit(); return; }
    }
    await sleep(args.poll);
  }
}

main().catch((e) => { process.stderr.write(`cmux-browser-element-pick: ${e.message}\n`); process.exit(1); });
