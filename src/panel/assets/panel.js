// honeyprompt monitoring panel — read-only, no build step, no dependencies.
"use strict";

const MAX_EVENTS = 1000;
const PREVIEW_COLUMNS = 8; // keep in sync with the table header

const el = {
  stats: document.getElementById("stats"),
  rows: document.getElementById("rows"),
  empty: document.getElementById("empty"),
  protocols: document.getElementById("protocols"),
  search: document.getElementById("search"),
  pause: document.getElementById("pause"),
  export: document.getElementById("export"),
  count: document.getElementById("count"),
  conn: document.getElementById("conn"),
  clock: document.getElementById("clock"),
};

const state = {
  events: [],
  expanded: new Set(),
  protocol: "",
  query: "",
  paused: false,
};

// ---- helpers ------------------------------------------------------------

function escapeHtml(value) {
  return String(value ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]),
  );
}

function timeOf(iso) {
  return new Date(iso).toLocaleTimeString([], { hour12: false });
}

function matchesFilter(e) {
  if (state.protocol && e.protocol !== state.protocol) return false;
  if (!state.query) return true;
  const haystack = `${e.input} ${e.output} ${e.remoteAddr} ${e.source} ${e.provider ?? ""} ${
    e.model ?? ""
  }`;
  return haystack.toLowerCase().includes(state.query);
}

// ---- rendering ----------------------------------------------------------

function render() {
  const visible = state.events.filter(matchesFilter).reverse();
  el.empty.classList.toggle("hidden", visible.length > 0);
  el.empty.textContent = state.events.length === 0
    ? "Waiting for the first knock…"
    : "No events match this filter.";
  el.count.textContent = `${visible.length} of ${state.events.length} events`;
  el.rows.innerHTML = visible.map(renderRow).join("");
}

function renderRow(e) {
  const open = state.expanded.has(e.id);
  const preview = `
    <tr class="row ${open ? "is-open" : ""}" data-id="${escapeHtml(e.id)}">
      <td><span class="caret">›</span></td>
      <td class="mono muted">${timeOf(e.ts)}</td>
      <td><span class="badge proto-${e.protocol}">${e.protocol}</span></td>
      <td class="mono">${escapeHtml(e.remoteAddr)}</td>
      <td><span class="src src-${e.source}">${e.source}</span></td>
      <td>${ioCell(e.input, "in")}</td>
      <td>${ioCell(e.output, "")}</td>
      <td class="ms">${e.latencyMs ?? ""}</td>
    </tr>`;
  return open ? preview + renderDetail(e) : preview;
}

function ioCell(value, extra) {
  if (!value) return `<span class="io-empty">—</span>`;
  return `<div class="io ${extra}">${escapeHtml(value)}</div>`;
}

function metaItem(key, value) {
  if (value == null || value === "") return "";
  return `<div class="meta-item">
    <span class="meta-key">${key}</span>
    <span class="meta-val">${escapeHtml(value)}</span>
  </div>`;
}

function renderDetail(e) {
  return `
    <tr class="detail">
      <td colspan="${PREVIEW_COLUMNS}">
        <div class="detail-grid">
          <div class="pane">
            <h4>Input</h4>
            <pre>${escapeHtml(e.input) || '<span class="muted">(none)</span>'}</pre>
          </div>
          <div class="pane">
            <h4>Output</h4>
            <pre>${escapeHtml(e.output) || '<span class="muted">(none)</span>'}</pre>
          </div>
        </div>
        <div class="meta-grid">
          ${metaItem("session", e.sessionId)}
          ${metaItem("service", e.service)}
          ${metaItem("listen", e.address)}
          ${metaItem("remote", e.remoteAddr)}
          ${metaItem("provider", e.provider)}
          ${metaItem("model", e.model)}
          ${metaItem("latency", e.latencyMs != null ? `${e.latencyMs} ms` : "")}
          ${metaItem("timestamp", new Date(e.ts).toISOString())}
        </div>
      </td>
    </tr>`;
}

function tile(label, value, accent) {
  return `<div class="tile ${accent ? "accent" : ""}">
    <div class="label">${label}</div><div class="value">${value}</div>
  </div>`;
}

async function loadStats() {
  const stats = await fetch("api/stats").then((r) => r.json()).catch(() => null);
  if (!stats) return;
  const by = stats.byProtocol || {};
  el.stats.innerHTML = [
    tile("events", stats.total, true),
    tile("http", by.http || 0),
    tile("ssh", by.ssh || 0),
    tile("tcp", by.tcp || 0),
    tile("telnet", by.telnet || 0),
    tile("providers", (stats.providers || []).length),
  ].join("");
}

// ---- data ---------------------------------------------------------------

function ingest(event) {
  state.events.push(event);
  if (state.events.length > MAX_EVENTS) {
    const dropped = state.events.splice(0, state.events.length - MAX_EVENTS);
    for (const e of dropped) state.expanded.delete(e.id);
  }
}

function stream() {
  const source = new EventSource("api/stream");
  source.onopen = () => setConn(true);
  source.onerror = () => setConn(false);
  source.onmessage = (message) => {
    ingest(JSON.parse(message.data));
    if (state.paused) return;
    render();
    if (state.events.length % 10 === 0) loadStats();
  };
}

function setConn(live) {
  el.conn.innerHTML = live
    ? '<span class="dot-ok">●</span> live'
    : '<span class="dot-off">●</span> reconnecting…';
}

function exportJson() {
  const blob = new Blob([JSON.stringify(state.events, null, 2)], { type: "application/json" });
  const anchor = document.createElement("a");
  anchor.href = URL.createObjectURL(blob);
  anchor.download = `honeyprompt-events-${new Date().toISOString().slice(0, 19)}.json`;
  anchor.click();
  URL.revokeObjectURL(anchor.href);
}

// ---- events -------------------------------------------------------------

el.rows.addEventListener("click", (event) => {
  const row = event.target.closest(".row");
  if (!row) return;
  const id = row.dataset.id;
  if (state.expanded.has(id)) state.expanded.delete(id);
  else state.expanded.add(id);
  render();
});

el.protocols.addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (!chip) return;
  state.protocol = chip.dataset.protocol;
  for (const c of el.protocols.querySelectorAll(".chip")) {
    c.classList.toggle("is-active", c === chip);
  }
  render();
});

el.search.addEventListener("input", () => {
  state.query = el.search.value.trim().toLowerCase();
  render();
});

el.pause.addEventListener("click", () => {
  state.paused = !state.paused;
  el.pause.textContent = state.paused ? "Resume" : "Pause";
  if (!state.paused) render();
});

el.export.addEventListener("click", exportJson);

setInterval(() => {
  el.clock.textContent = new Date().toLocaleTimeString([], { hour12: false });
}, 1000);

async function boot() {
  state.events = await fetch(`api/events?limit=${MAX_EVENTS}`).then((r) => r.json()).catch(
    () => [],
  );
  render();
  loadStats();
  stream();
}

boot();
