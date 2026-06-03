// Minimal newline-delimited-JSON client for the cmux Unix socket.
// Messages: {id, method, params}\n  ->  {ok, result|error, id}\n
// One persistent connection per process; requests matched by id.

import net from "node:net";

const SOCK = process.env.CMUX_SOCKET_PATH;

let sock = null;
let buf = "";
let seq = 0;
const pending = new Map();

function ensure() {
  if (sock) return sock;
  sock = net.connect(SOCK);
  sock.setNoDelay(true);
  sock.on("data", (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line) continue;
      let o;
      try { o = JSON.parse(line); } catch (_) { continue; }
      const p = pending.get(o.id);
      if (!p) continue;
      pending.delete(o.id);
      o.ok ? p.resolve(o.result) : p.reject(new Error((o.error && o.error.message) || "cmux socket error"));
    }
  });
  const fail = (e) => { for (const p of pending.values()) p.reject(e); pending.clear(); sock = null; };
  sock.on("error", fail);
  sock.on("close", () => { sock = null; });
  return sock;
}

export function hasSocket() {
  return !!SOCK;
}

export function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    let s;
    try { s = ensure(); } catch (e) { return reject(e); }
    const id = "r" + (++seq);
    pending.set(id, { resolve, reject });
    try { s.write(JSON.stringify({ id, method, params }) + "\n"); }
    catch (e) { pending.delete(id); reject(e); }
  });
}

export function closeSocket() {
  if (sock) { try { sock.end(); } catch (_) {} sock = null; }
}
