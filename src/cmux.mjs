// Thin wrappers around the `cmux` CLI. All calls use execFile with an argv
// array (no shell), so element scripts and payloads need no quoting.

import { execFile } from "node:child_process";

function run(args, { json = false } = {}) {
  return new Promise((resolve, reject) => {
    const argv = json ? ["--json", ...args] : args;
    execFile("cmux", argv, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.message = `cmux ${argv.join(" ")}\n${stderr || err.message}`;
        return reject(err);
      }
      resolve(stdout);
    });
  });
}

export async function tree() {
  return JSON.parse(await run(["tree"], { json: true }));
}

// Flatten the --json tree into a list of surfaces with workspace context.
export function surfaces(treeJson) {
  const out = [];
  for (const w of treeJson.windows || []) {
    for (const ws of w.workspaces || []) {
      for (const pane of ws.panes || []) {
        for (const s of pane.surfaces || []) {
          out.push({
            ref: s.ref,
            type: s.type,
            url: s.url || null,
            title: s.title || null,
            here: !!s.here,
            workspace_ref: ws.ref,
            window_ref: w.ref,
          });
        }
      }
    }
  }
  return out;
}

// Run JS in a browser surface and return the unwrapped value.
export async function browserEval(surface, script) {
  const out = await run(["browser", surface, "eval", script], { json: true });
  return JSON.parse(out).value;
}

export async function browserAddInitScript(surface, script) {
  // Re-installs the picker on future navigations within this surface.
  await run(["browser", surface, "addinitscript", script]);
}

// Send a SINGLE LINE of text into a terminal surface. cmux send treats \n/\r as
// Enter, so callers must not include newlines unless they want a submit.
export async function sendText(surface, text) {
  await run(["send", "--surface", surface, "--", text]);
}

// Paste a multi-line block into a surface. NOTE: cmux paste-buffer forwards raw
// newlines (the interactive shell/agent may execute each line). Prefer the
// file-drop + sendText path; this is opt-in via --inline.
export async function pasteToSurface(surface, text) {
  await run(["set-buffer", "--", text]);
  await run(["paste-buffer", "--surface", surface]);
}

export async function sendKey(surface, key) {
  await run(["send-key", "--surface", surface, key]);
}

export async function notify(title, body) {
  try {
    await run(["notify", "--title", title, "--body", body || ""]);
  } catch (_) { /* non-fatal */ }
}
