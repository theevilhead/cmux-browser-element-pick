// cmux access layer. Prefers the Unix socket (one persistent connection, no
// per-call process spawn) and falls back to the `cmux` CLI when the socket is
// unavailable. Exposed functions return the same shapes regardless of backend,
// so the driver and picker don't care which is in use.
//
// Backend differences hidden here:
//   - socket addresses surfaces by UUID; CLI by ref ("surface:N").
//     tree() normalizes so each surface's `ref` is the value THIS backend's
//     calls accept, and selfRef() returns the driver's own surface in the same
//     id space (CMUX_SURFACE_ID for socket, identify.caller for CLI).

import { execFile } from "node:child_process";
import { rpc, hasSocket, closeSocket } from "./socket.mjs";

let backend = null; // "socket" | "cli"

function cli(args, { json = false } = {}) {
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

async function pickBackend() {
  if (backend) return backend;
  if (hasSocket()) {
    try { await rpc("system.tree"); backend = "socket"; return backend; }
    catch (_) { /* socket not reachable; fall back */ }
  }
  backend = "cli";
  return backend;
}

export async function backendName() {
  return pickBackend();
}

export { closeSocket };

// Normalize the socket's system.tree (+ identify) into the CLI --json tree
// shape the driver expects. Each surface's `ref` becomes its UUID `id`, because
// socket calls target surfaces by UUID.
function normSocketTree(t, ident) {
  const windows = (t.windows || []).map((w) => ({
    ref: w.id,
    workspaces: (w.workspaces || []).map((ws) => ({
      ref: ws.id,
      panes: (ws.panes || []).map((p) => ({
        ref: p.id,
        surfaces: (p.surfaces || []).map((s) => ({
          ref: s.id, type: s.type, url: s.url || null, title: s.title || null,
        })),
      })),
    })),
  }));
  const f = ident && ident.focused;
  return {
    windows,
    caller: process.env.CMUX_SURFACE_ID
      ? { surface_ref: process.env.CMUX_SURFACE_ID, surface_type: null }
      : null,
    active: f ? { surface_ref: f.surface_id, is_browser_surface: f.is_browser_surface } : null,
  };
}

export async function tree() {
  const b = await pickBackend();
  if (b === "socket") {
    const [t, id] = await Promise.all([rpc("system.tree"), rpc("system.identify")]);
    return normSocketTree(t, id);
  }
  return JSON.parse(await cli(["tree"], { json: true }));
}

// Flatten a tree (either backend's shape) into a list of surfaces.
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

// The driver's own surface, in the same id space as surface `ref`s.
export function selfRef(treeJson) {
  if (backend === "socket") return process.env.CMUX_SURFACE_ID || null;
  return (treeJson && treeJson.caller && treeJson.caller.surface_ref) || null;
}

// Run JS in a browser surface and return the unwrapped value.
export async function browserEval(surface, script) {
  const b = await pickBackend();
  if (b === "socket") {
    const r = await rpc("browser.eval", { surface_id: surface, script });
    return r && r.value;
  }
  return JSON.parse(await cli(["browser", surface, "eval", script], { json: true })).value;
}

// NOTE: cmux's browser.wait --function holds the WKWebView JS main thread for
// the whole timeout, freezing the page. So the driver does NOT long-poll; it
// runs short non-blocking evals with a sleep between them instead.

// Send a SINGLE LINE of text into a terminal surface. cmux treats \n/\r as
// Enter, so callers must not include newlines unless they want a submit.
export async function sendText(surface, text) {
  const b = await pickBackend();
  if (b === "socket") { await rpc("surface.send_text", { surface_id: surface, text }); return; }
  await cli(["send", "--surface", surface, "--", text]);
}

export async function sendKey(surface, key) {
  const b = await pickBackend();
  if (b === "socket") { await rpc("surface.send_key", { surface_id: surface, key }); return; }
  await cli(["send-key", "--surface", surface, key]);
}

// Paste a multi-line block via bracketed paste (--inline path). CLI-only; the
// socket has no buffer/paste method. The CLI accepts UUIDs as well as refs.
export async function pasteToSurface(surface, text) {
  await cli(["set-buffer", "--", text]);
  await cli(["paste-buffer", "--surface", surface]);
}

export async function notify(title, body) {
  try { await cli(["notify", "--title", title, "--body", body || ""]); }
  catch (_) { /* non-fatal */ }
}
