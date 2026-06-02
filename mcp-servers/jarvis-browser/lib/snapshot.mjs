/**
 * Token-careful, ref-based accessibility snapshot.
 *
 * `SNAPSHOT_FN` runs IN the page: it tags every visible interactive element with
 * a stable `data-jbref="N"` attribute and returns a compact descriptor list —
 * never the raw DOM/HTML. Actions then target `[data-jbref="N"]`, so the agent
 * drives deterministically from `[N] role "name"` lines with no second LLM.
 *
 * `serialize()` turns a snapshot into the minimal text the agent reads.
 * `diff()` returns only what changed since the previous snapshot (incremental
 * mode) so repeat steps cost ~0 perception tokens.
 */

// NOTE: must be fully self-contained — it is serialized and run in the page.
export const SNAPSHOT_FN = (opts) => {
  const max = (opts && opts.max) || 200;
  const nameCap = 120;

  const visible = (el) => {
    const rects = el.getClientRects();
    if (!rects || rects.length === 0) return false;
    const s = window.getComputedStyle(el);
    if (s.visibility === "hidden" || s.display === "none" || s.opacity === "0") return false;
    const r = el.getBoundingClientRect();
    return r.width >= 1 || r.height >= 1;
  };

  const txt = (s) => (s || "").replace(/\s+/g, " ").trim();

  const accName = (el) => {
    let n = el.getAttribute("aria-label");
    if (!n) {
      const lb = el.getAttribute("aria-labelledby");
      if (lb) n = lb.split(/\s+/).map((id) => { const e = document.getElementById(id); return e ? e.innerText : ""; }).join(" ");
    }
    if (!n) n = el.getAttribute("alt");
    if (!n) n = el.getAttribute("placeholder");
    if (!n && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) n = el.getAttribute("name");
    if (!n) n = el.innerText;
    if (!n) n = el.getAttribute("title");
    if (!n) n = el.getAttribute("value");
    n = txt(n);
    if (n.length > nameCap) n = n.slice(0, nameCap - 1) + "…";
    return n;
  };

  const roleOf = (el) => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return el.hasAttribute("href") ? "link" : "generic";
    if (tag === "button") return "button";
    if (tag === "input") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "checkbox") return "checkbox";
      if (t === "radio") return "radio";
      if (t === "submit" || t === "button" || t === "reset") return "button";
      if (t === "search") return "searchbox";
      if (t === "hidden") return "hidden";
      return "textbox";
    }
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "summary") return "disclosure";
    return tag;
  };

  const selector = [
    "a[href]", "button", "input:not([type=hidden])", "select", "textarea",
    "summary", "[role]", '[contenteditable=""]', '[contenteditable="true"]',
    "[onclick]", "[tabindex]:not([tabindex='-1'])",
  ].join(",");

  document.querySelectorAll("[data-jbref]").forEach((e) => e.removeAttribute("data-jbref"));

  const editable = new Set(["textbox", "combobox", "checkbox", "radio", "searchbox"]);
  const out = [];
  const seen = new Set();
  let truncated = false;

  for (const el of document.querySelectorAll(selector)) {
    if (out.length >= max) { truncated = true; break; }
    if (seen.has(el)) continue;
    seen.add(el);
    const role = roleOf(el);
    if (role === "hidden" || role === "generic") continue;
    if (!visible(el)) continue;
    const name = accName(el);
    if (!name && !editable.has(role)) continue;

    const ref = out.length + 1;
    el.setAttribute("data-jbref", String(ref));
    const item = { ref, role, name };
    if (el.tagName === "INPUT" || el.tagName === "TEXTAREA") {
      const t = (el.getAttribute("type") || "text").toLowerCase();
      if (t !== "text") item.type = t;
      if (el.value) item.value = String(el.value).slice(0, 60);
      if (el.checked) item.checked = true;
    }
    if (el.disabled) item.disabled = true;
    out.push(item);
  }

  return {
    url: location.href,
    title: document.title,
    scrollY: Math.round(window.scrollY),
    scrollMaxY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight),
    elements: out,
    truncated,
  };
};

const sig = (e) =>
  `${e.role}|${e.name}|${e.value || ""}|${e.checked ? 1 : 0}|${e.disabled ? 1 : 0}`;

const line = (e) => {
  let s = `[${e.ref}] ${e.role}`;
  if (e.name) s += ` "${e.name}"`;
  if (e.type) s += ` <${e.type}>`;
  if (e.value) s += ` =${JSON.stringify(e.value)}`;
  if (e.checked) s += " [checked]";
  if (e.disabled) s += " [disabled]";
  return s;
};

export function serialize(snap, { header = true } = {}) {
  const lines = [];
  if (header) {
    lines.push(`url: ${snap.url}`);
    lines.push(`title: ${snap.title}`);
    if (snap.scrollMaxY > 0) lines.push(`scroll: ${snap.scrollY}/${snap.scrollMaxY}`);
    lines.push(`${snap.elements.length} interactive element(s)${snap.truncated ? " (truncated)" : ""}:`);
  }
  for (const e of snap.elements) lines.push(line(e));
  return lines.join("\n");
}

// Incremental: describe what changed vs the previous snapshot, by accessible
// signature (role+name+value+state), so unchanged structure costs ~0 tokens.
export function diff(prev, next) {
  if (!prev) return { text: serialize(next), changed: next.elements.length, full: true };
  const navigated = prev.url !== next.url;
  const prevBySig = new Map(prev.elements.map((e) => [sig(e), e]));
  const nextBySig = new Map(next.elements.map((e) => [sig(e), e]));

  const added = next.elements.filter((e) => !prevBySig.has(sig(e)));
  const removed = prev.elements.filter((e) => !nextBySig.has(sig(e)));

  const lines = [];
  if (navigated) lines.push(`navigated -> ${next.url}`);
  else if (prev.title !== next.title) lines.push(`title -> ${next.title}`);
  if (next.scrollMaxY > 0 && next.scrollY !== prev.scrollY) lines.push(`scroll: ${next.scrollY}/${next.scrollMaxY}`);

  if (!added.length && !removed.length) {
    lines.push(navigated ? `${next.elements.length} element(s) (same structure)` : "no element changes");
  } else {
    if (added.length) { lines.push(`+ ${added.length} new:`); added.forEach((e) => lines.push("  " + line(e))); }
    if (removed.length) lines.push(`- ${removed.length} removed (refs reassigned)`);
  }
  return { text: lines.join("\n"), changed: added.length + removed.length, full: false, navigated };
}
