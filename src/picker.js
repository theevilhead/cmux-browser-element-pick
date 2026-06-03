// cmux-browser-element-pick in-page picker.
// Injected into the cmux WKWebView via `cmux browser <surface> eval`.
// Adds a hover overlay + click capture. Each captured element is pushed onto
// window.__cmuxPicks, which the driver drains over the cmux CLI.
//
// Self-contained IIFE, idempotent. Esc removes the picker.
(() => {
  if (window.__cmuxPickerInstalled) return "already-installed";
  window.__cmuxPickerInstalled = true;
  window.__cmuxPickerDisabled = false;
  window.__cmuxPicks = window.__cmuxPicks || [];

  const OVERLAY_ID = "__cmux_pick_overlay__";
  const LABEL_ID = "__cmux_pick_label__";
  const TOAST_ID = "__cmux_pick_toast__";
  const COMMENT_ID = "__cmux_pick_comment__";

  // Computed-CSS allowlist, grouped for UI-dev relevance.
  const CSS_PROPS = [
    // layout
    "display","position","top","right","bottom","left","float","clear",
    "flex-direction","flex-wrap","justify-content","align-items","align-content","gap",
    "grid-template-columns","grid-template-rows","grid-auto-flow",
    "width","height","min-width","min-height","max-width","max-height","box-sizing",
    "margin-top","margin-right","margin-bottom","margin-left",
    "padding-top","padding-right","padding-bottom","padding-left","overflow",
    // typography
    "font-family","font-size","font-weight","font-style","line-height",
    "letter-spacing","text-align","text-transform","text-decoration","white-space","color",
    // box / surface
    "background-color","background-image","border-radius","box-shadow",
    "border-top-width","border-top-style","border-top-color",
    "border-bottom-width","border-left-width","border-right-width",
    // effects
    "opacity","transform","transition","cursor","z-index",
  ];

  function px(n) { return Math.round(n) + "px"; }

  function ensure(id, styleText) {
    let el = document.getElementById(id);
    if (!el) {
      el = document.createElement("div");
      el.id = id;
      el.style.cssText = styleText;
      document.documentElement.appendChild(el);
    }
    return el;
  }

  const overlay = ensure(OVERLAY_ID,
    "position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #4f8cff;" +
    "background:rgba(79,140,255,.12);border-radius:2px;display:none;transition:all .03s;");
  const label = ensure(LABEL_ID,
    "position:fixed;pointer-events:none;z-index:2147483647;background:#1f2937;color:#fff;" +
    "font:11px/1.4 ui-monospace,Menlo,monospace;padding:2px 6px;border-radius:4px;display:none;white-space:nowrap;");

  function isOurs(el) {
    if (!el || el.nodeType !== 1) return false;
    if (el.id === OVERLAY_ID || el.id === LABEL_ID || el.id === TOAST_ID || el.id === COMMENT_ID) return true;
    // The comment box has children (label, input); treat its whole subtree as ours.
    const box = document.getElementById(COMMENT_ID);
    return !!(box && box.contains(el));
  }

  function selectorPath(el) {
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      let sel = node.tagName.toLowerCase();
      if (node.id) { sel += "#" + CSS.escape(node.id); parts.unshift(sel); break; }
      const cls = (node.getAttribute("class") || "").trim().split(/\s+/).filter(Boolean).slice(0, 2);
      if (cls.length) sel += "." + cls.map((c) => CSS.escape(c)).join(".");
      const parent = node.parentElement;
      if (parent) {
        const same = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
        if (same.length > 1) sel += ":nth-of-type(" + (same.indexOf(node) + 1) + ")";
      }
      parts.unshift(sel);
      node = node.parentElement;
    }
    return parts.join(" > ");
  }

  function xpath(el) {
    if (el.id) return '//*[@id="' + el.id + '"]';
    const parts = [];
    let node = el;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      let i = 1, sib = node.previousElementSibling;
      while (sib) { if (sib.tagName === node.tagName) i++; sib = sib.previousElementSibling; }
      parts.unshift(node.tagName.toLowerCase() + "[" + i + "]");
      node = node.parentElement;
    }
    return "/html/" + parts.join("/");
  }

  function computedCss(el) {
    const cs = getComputedStyle(el);
    const out = {};
    for (const p of CSS_PROPS) {
      const v = cs.getPropertyValue(p);
      if (v && v !== "none" && v !== "normal" && v !== "auto" && v !== "0px" && v !== "rgba(0, 0, 0, 0)")
        out[p] = v.trim();
    }
    return out;
  }

  // Find the custom properties this element actually references via var() - in
  // its inline style and in the CSS rules whose selector matches it. Then
  // resolve each to its effective value. This keeps tokens element-relevant
  // instead of dumping the whole :root palette. Cross-origin sheets are skipped.
  function matchedVarRefs(el) {
    const refs = new Set();
    const addFrom = (txt) => {
      if (!txt) return;
      const re = /var\(\s*(--[A-Za-z0-9_-]+)/g;
      let m;
      while ((m = re.exec(txt))) refs.add(m[1]);
    };
    addFrom(el.getAttribute("style"));
    const scan = (rules) => {
      for (const r of rules) {
        try {
          if (r.selectorText) {
            let matches = false;
            try { matches = el.matches(r.selectorText); } catch (_) { /* bad selector */ }
            if (matches && r.style) addFrom(r.style.cssText);
          }
          if (r.cssRules) scan(r.cssRules);
        } catch (_) { /* ignore */ }
      }
    };
    for (const sheet of Array.from(document.styleSheets)) {
      try { scan(sheet.cssRules); } catch (_) { /* cross-origin */ }
    }
    return refs;
  }

  function designTokens(el) {
    const cs = getComputedStyle(el);
    const out = {};
    let count = 0;
    for (const name of matchedVarRefs(el)) {
      if (count >= 40) break;
      const v = cs.getPropertyValue(name).trim();
      if (v) { out[name] = v; count++; }
    }
    return out;
  }

  function trimHtml(el, max = 2000) {
    let html = el.outerHTML.replace(/\s+/g, " ").trim();
    if (html.length > max) html = html.slice(0, max) + " …(truncated)";
    return html;
  }

  // Ancestors immediate-parent-first up to and including body, capped at 6.
  function parentHierarchy(el) {
    const out = [];
    let node = el.parentElement;
    while (node && node.nodeType === 1 && out.length < 6) {
      out.push({
        tag: node.tagName.toLowerCase(),
        id: node.id || null,
        classes: (node.getAttribute("class") || "").trim() || null,
        selector: selectorPath(node),
      });
      if (node.tagName === "BODY") break;
      node = node.parentElement;
    }
    return out;
  }

  function capture(el) {
    const r = el.getBoundingClientRect();
    return {
      pageUrl: location.href,
      ts: Date.now(),
      tagName: el.tagName.toLowerCase(),
      id: el.id || null,
      classes: (el.getAttribute("class") || "").trim() || null,
      role: el.getAttribute("role") || null,
      visibleText: (el.innerText || "").replace(/\s+/g, " ").trim().slice(0, 200) || null,
      selector: selectorPath(el),
      xpath: xpath(el),
      boundingBox: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      computedStyles: computedCss(el),
      tokens: designTokens(el),
      selectedElementHtml: trimHtml(el),
      parentHierarchy: parentHierarchy(el),
      userComment: null,
    };
  }

  function toast(msg) {
    const t = ensure(TOAST_ID,
      "position:fixed;z-index:2147483647;left:50%;bottom:24px;transform:translateX(-50%);" +
      "background:#16a34a;color:#fff;font:13px/1.4 ui-sans-serif,system-ui;padding:8px 14px;" +
      "border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.3);transition:opacity .2s;");
    t.textContent = msg;
    t.style.opacity = "1";
    t.style.display = "block";
    clearTimeout(t.__timer);
    t.__timer = setTimeout(() => { t.style.opacity = "0"; }, 1200);
  }

  let current = null;
  // The pick captured at click time, awaiting an optional comment. While set,
  // the comment box is open and Esc cancels the box instead of tearing down.
  let pendingPick = null;

  function hideOverlay() {
    overlay.style.display = "none";
    label.style.display = "none";
  }

  function closeCommentBox() {
    pendingPick = null;
    const box = document.getElementById(COMMENT_ID);
    if (box) box.remove();
  }

  // Build the comment box fresh each time so its input starts empty/focused.
  function openCommentBox(pick) {
    closeCommentBox();
    pendingPick = pick;
    const box = document.createElement("div");
    box.id = COMMENT_ID;
    box.style.cssText =
      "position:fixed;z-index:2147483647;left:50%;bottom:72px;transform:translateX(-50%);" +
      "background:#0f172a;color:#e5e7eb;font:13px/1.4 ui-sans-serif,system-ui;padding:12px 14px;" +
      "border:1px solid #4f8cff;border-radius:10px;box-shadow:0 8px 28px rgba(0,0,0,.45);" +
      "display:flex;flex-direction:column;gap:8px;min-width:320px;max-width:480px;";

    const lbl = document.createElement("div");
    lbl.textContent = "Add a note (optional) - Enter to send, Esc to cancel";
    lbl.style.cssText = "font-size:12px;color:#9ca3af;";

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "e.g. this button should be larger";
    input.style.cssText =
      "background:#1e293b;color:#fff;border:1px solid #334155;border-radius:6px;" +
      "padding:7px 9px;font:13px/1.4 ui-sans-serif,system-ui;outline:none;width:100%;box-sizing:border-box;";

    // Stop the picker's capture-phase listeners from swallowing input keys/clicks.
    const stop = (ev) => { ev.stopPropagation(); };
    input.addEventListener("keydown", (ev) => {
      ev.stopPropagation();
      if (ev.key === "Enter") {
        ev.preventDefault();
        submitComment(input.value);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        closeCommentBox();
        toast("Pick cancelled");
      }
    }, true);
    input.addEventListener("keyup", stop, true);
    box.addEventListener("click", stop, true);
    box.addEventListener("mousedown", stop, true);
    box.addEventListener("pointerdown", stop, true);

    box.appendChild(lbl);
    box.appendChild(input);
    document.documentElement.appendChild(box);
    input.focus();
  }

  function submitComment(value) {
    if (!pendingPick) return;
    const pick = pendingPick;
    pick.userComment = (value || "").trim() || null;
    try {
      window.__cmuxPicks.push(pick);
      toast("✓ Picked " + pick.tagName + " → agent");
    } catch (err) {
      toast("Pick failed: " + (err && err.message));
    }
    closeCommentBox();
  }

  // Armed only while Option/Alt is held, so normal browsing (clicks, links,
  // scrolling) works while cmux-browser-element-pick stays running in the background.
  function isArmed(e) {
    return !!(e && e.altKey);
  }

  function onMove(e) {
    if (!isArmed(e)) { hideOverlay(); current = null; return; }
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || isOurs(el)) return;
    current = el;
    const r = el.getBoundingClientRect();
    overlay.style.display = "block";
    overlay.style.left = px(r.left);
    overlay.style.top = px(r.top);
    overlay.style.width = px(r.width);
    overlay.style.height = px(r.height);
    label.style.display = "block";
    label.textContent = el.tagName.toLowerCase() +
      (el.id ? "#" + el.id : "") + "  " + Math.round(r.width) + "×" + Math.round(r.height);
    const ly = r.top - 20 < 0 ? r.top + 4 : r.top - 20;
    label.style.left = px(Math.max(2, r.left));
    label.style.top = px(Math.max(2, ly));
  }

  // Swallow the interaction only when armed, so links/buttons don't navigate or
  // fire on the pick. Un-modified clicks pass through to the page.
  function swallow(e) {
    if (isOurs(e.target) || !isArmed(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  function onClick(e) {
    if (isOurs(e.target) || !isArmed(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const el = current || e.target;
    try {
      // Capture now so later DOM changes do not affect the pick; collect the
      // comment interactively, then push the assembled object on submit.
      openCommentBox(capture(el));
    } catch (err) {
      toast("Pick failed: " + (err && err.message));
    }
  }

  function teardown() {
    window.__cmuxPickerInstalled = false;
    // Mark an explicit user stop so the driver does NOT re-inject. Cleared
    // automatically on navigation (fresh window), which re-arms the picker.
    window.__cmuxPickerDisabled = true;
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("pointerdown", swallow, true);
    document.removeEventListener("mousedown", swallow, true);
    document.removeEventListener("mouseup", swallow, true);
    document.removeEventListener("auxclick", swallow, true);
    document.removeEventListener("click", onClick, true);
    document.removeEventListener("keydown", onKey, true);
    closeCommentBox();
    overlay.remove(); label.remove();
    toast("Picker off");
  }

  function onKey(e) {
    if (e.key !== "Escape") return;
    // When the comment box is open its own handler cancels it; do not tear down.
    if (pendingPick) return;
    e.preventDefault();
    teardown();
  }

  document.addEventListener("mousemove", onMove, true);
  document.addEventListener("pointerdown", swallow, true);
  document.addEventListener("mousedown", swallow, true);
  document.addEventListener("mouseup", swallow, true);
  document.addEventListener("auxclick", swallow, true);
  document.addEventListener("click", onClick, true);
  document.addEventListener("keydown", onKey, true);
  toast("Picker on - Option+Click an element to send it (Esc to stop)");
  return "installed";
})();
