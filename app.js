// Site Materials — static single-page app.
// Reads come straight from Supabase (anon key, guarded by RLS). Everything
// privileged (login, clock-out, deliveries, activity, admin edits) goes through
// the `login` / `api` edge functions, which hold the service key.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

// ---- Config (safe to be public: anon key + project URL) --------------------
const SUPABASE_URL = "https://qticvdfcanuptafxruex.supabase.co";
const ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF0aWN2ZGZjYW51cHRhZnhydWV4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcyNjgwOTMsImV4cCI6MjEwMjg0NDA5M30.RdDv1Lkf9_cg0NOeNR51ouCtm8j62kLNjXvSK95LSY4";
const FN = SUPABASE_URL + "/functions/v1";

// Current job site. One site for now; when a second job starts we'll make this
// a per-site selection instead of a constant.
const SITE_NAME = "Tru Durham (TSR)";

const sb = createClient(SUPABASE_URL, ANON_KEY, { db: { schema: "materials" } });
const app = document.getElementById("app");

// ---- Session ---------------------------------------------------------------
function getSession() {
  try {
    return JSON.parse(localStorage.getItem("sm_session"));
  } catch {
    return null;
  }
}
function setSession(s) { localStorage.setItem("sm_session", JSON.stringify(s)); }
function clearSession() { localStorage.removeItem("sm_session"); }
function validSession(s) { return s && s.token && s.exp > Date.now(); }

// ---- Helpers ---------------------------------------------------------------
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmt = (n) => { const x = Number(n); return Number.isInteger(x) ? String(x) : String(Math.round(x * 100) / 100); };

function toast(msg) {
  const t = document.getElementById("toast");
  t.textContent = msg; t.hidden = false;
  clearTimeout(toast._t); toast._t = setTimeout(() => (t.hidden = true), 3000);
}

async function apiCall(action, body = {}, fn = "api") {
  const s = getSession();
  const r = await fetch(FN + "/" + fn, {
    method: "POST",
    headers: { apikey: ANON_KEY, Authorization: "Bearer " + ANON_KEY, "Content-Type": "application/json", "x-session-token": s?.token || "" },
    body: JSON.stringify({ action, ...body }),
  });
  let j = {};
  try { j = await r.json(); } catch {}
  if (r.status === 401) { clearSession(); location.hash = "#/login"; render(); throw new Error("Your session expired — please log in again."); }
  if (!r.ok) throw Object.assign(new Error(j.error || "Something went wrong."), { status: r.status, code: j.error });
  return j;
}
const importCall = (action, body = {}) => apiCall(action, body, "imports");
const requestCall = (action, body = {}) => apiCall(action, body, "requests");

// ---- Direct reads ----------------------------------------------------------
async function readTrades() { return (await sb.from("trades").select("id,name").order("name")).data || []; }
async function readWorkersForLogin() { return (await sb.from("workers").select("id,name,role,trade_id").eq("active", true).order("name")).data || []; }
async function readWorkers() { return (await sb.from("workers").select("id,name,role,active,trade_id,trades(name)").order("name")).data || []; }
async function readLocations() { return (await sb.from("locations").select("id,name,description").order("name")).data || []; }
async function readTrade(id) { return (await sb.from("trades").select("id,name").eq("id", id).single()).data; }

async function readMaterialsWithStock(tradeId) {
  const materials = (await sb.from("materials").select("id,name,unit,phase,category,reorder_threshold").eq("trade_id", tradeId).order("name")).data || [];
  const ids = materials.map((m) => m.id);
  const inv = ids.length
    ? (await sb.from("inventory_items").select("quantity_on_hand,material_id,location_id,locations(name)").in("material_id", ids)).data || []
    : [];
  const byMat = new Map();
  for (const r of inv) {
    const list = byMat.get(r.material_id) || [];
    list.push({ locationId: r.location_id, name: r.locations?.name || "Unknown", qty: Number(r.quantity_on_hand) });
    byMat.set(r.material_id, list);
  }
  return materials.map((m) => ({ ...m, locations: byMat.get(m.id) || [] }));
}

// ---- Offline queue (IndexedDB) --------------------------------------------
function idb() {
  return new Promise((res, rej) => {
    const rq = indexedDB.open("site-materials", 1);
    rq.onupgradeneeded = () => { if (!rq.result.objectStoreNames.contains("queue")) rq.result.createObjectStore("queue", { keyPath: "clientUuid" }); };
    rq.onsuccess = () => res(rq.result);
    rq.onerror = () => rej(rq.error);
  });
}
async function queuePut(item) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction("queue", "readwrite"); t.objectStore("queue").put(item); t.oncomplete = res; t.onerror = () => rej(t.error); }); }
async function queueAll() { const db = await idb(); return new Promise((res, rej) => { const r = db.transaction("queue", "readonly").objectStore("queue").getAll(); r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error); }); }
async function queueDel(id) { const db = await idb(); return new Promise((res, rej) => { const t = db.transaction("queue", "readwrite"); t.objectStore("queue").delete(id); t.oncomplete = res; t.onerror = () => rej(t.error); }); }

let syncing = false;
async function flushQueue() {
  if (syncing || !navigator.onLine || !validSession(getSession())) return;
  syncing = true;
  try {
    const items = await queueAll();
    if (items.length) setNet("syncing", `Syncing ${items.length} clock-out${items.length === 1 ? "" : "s"}…`);
    for (const it of items) {
      try {
        await apiCall("clock_out", { tradeId: it.tradeId, notes: it.notes, lines: it.lines, clientUuid: it.clientUuid });
        await queueDel(it.clientUuid);
      } catch (e) {
        if (e.code === "insufficient_stock") { await queueDel(it.clientUuid); toast("A saved clock-out couldn't post — stock ran out. Please re-check and request more."); }
        else break; // transient — retry next time
      }
    }
  } finally {
    syncing = false;
    updateNet();
  }
}

function setNet(kind, msg) { const b = document.getElementById("netbar"); b.className = "netbar " + kind; b.textContent = msg; b.hidden = false; }
async function updateNet() {
  const b = document.getElementById("netbar");
  const pending = (await queueAll()).length;
  if (!navigator.onLine) return setNet("offline", pending ? `Offline — ${pending} clock-out${pending === 1 ? "" : "s"} saved, will sync later.` : "Offline — you can still clock out.");
  if (pending) return setNet("syncing", `${pending} clock-out${pending === 1 ? "" : "s"} waiting to sync…`);
  b.hidden = true;
}

// ---- Header ----------------------------------------------------------------
function header(active) {
  const s = getSession();
  const elevated = s?.role === "admin" || s?.role === "superintendent";
  const tab = (href, label) => `<a href="${href}" class="${active === href ? "active" : ""}">${label}</a>`;
  let tabs = "";
  if (elevated) {
    tabs = [tab("#/", "Trades"), tab("#/admin/inventory", "Inventory"), tab("#/admin/requests", "Requests"), tab("#/admin", "Admin")].join("");
  } else {
    tabs = tab("#/request", "Request") + tab("#/account", "My PIN");
  }
  return `<header>
    <a class="wordmark" href="#/">
      <span class="mark">N</span>
      <span class="wm-lines"><span class="wm-eyebrow">Novel Construction</span><span class="wm-title">Site Materials</span></span>
    </a>
    <nav class="tabs">${tabs}<a href="#/logout">Log out</a></nav>
  </header>
  <div class="jobbar">${esc(SITE_NAME)}</div>
  <div class="wholine">${esc(s?.name || "")} · ${esc(s?.role === "admin" ? "owner" : s?.role === "superintendent" ? "super" : "sub")}</div>`;
}

// ---- Views -----------------------------------------------------------------
async function viewLogin() {
  const workers = await readWorkersForLogin();
  app.innerHTML = `<div class="login">
    <div class="brand-lockup"><span class="mark">N</span><span style="display:flex;flex-direction:column;line-height:1.2"><span class="co">Novel Construction</span><span class="nm">Site Materials</span></span></div>
    <p class="eyebrow">Field &amp; office</p>
    <h1>Clock in.</h1>
    <p class="sub">Pick your name and enter your PIN.</p>
    <div class="field" style="margin-top:20px"><label>Name</label>
      <select id="who"><option value="">Select your name…</option>${workers.map((w) => `<option value="${w.id}" data-role="${w.role}" data-trade="${w.trade_id || ""}">${esc(w.name)}</option>`).join("")}</select></div>
    <div class="field"><label>PIN</label><input id="pin" type="password" inputmode="numeric" autocomplete="off" /></div>
    <div id="err"></div>
    <button class="block" id="go">Clock in</button>
  </div>`;
  const go = document.getElementById("go");
  const submit = async () => {
    const workerId = document.getElementById("who").value;
    const pin = document.getElementById("pin").value;
    const err = document.getElementById("err");
    err.innerHTML = "";
    if (!workerId || !pin) { err.innerHTML = `<div class="notice error">Pick your name and enter your PIN.</div>`; return; }
    go.disabled = true; go.textContent = "Checking…";
    try {
      const r = await fetch(FN + "/login", { method: "POST", headers: { apikey: ANON_KEY, Authorization: "Bearer " + ANON_KEY, "Content-Type": "application/json" }, body: JSON.stringify({ workerId, pin }) });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error === "invalid" ? "That name and PIN don't match." : j.error || "Login failed.");
      setSession({ token: j.token, name: j.worker.name, role: j.worker.role, tradeId: j.worker.tradeId, exp: j.exp });
      location.hash = "#/"; render();
    } catch (e) {
      err.innerHTML = `<div class="notice error">${esc(e.message)}</div>`;
      go.disabled = false; go.textContent = "Clock in";
    }
  };
  go.onclick = submit;
  document.getElementById("pin").addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); });
}

async function viewHome() {
  const s = getSession();
  // Subs are scoped to their own trade — go straight there. Owners and
  // superintendents see the whole site.
  if (s.role !== "admin" && s.role !== "superintendent") {
    if (s.tradeId) { location.hash = "#/trade/" + s.tradeId; return; }
    app.innerHTML = header("#/") + `<div class="box">You're not assigned to a trade yet. Ask an owner to set your trade in Settings.</div>`;
    return;
  }
  const [trades, materials, inv] = await Promise.all([
    readTrades(),
    sb.from("materials").select("id,trade_id,reorder_threshold").then((r) => r.data || []),
    sb.from("inventory_items").select("material_id,quantity_on_hand").then((r) => r.data || []),
  ]);
  const onHand = new Map();
  for (const r of inv) onHand.set(r.material_id, (onHand.get(r.material_id) || 0) + Number(r.quantity_on_hand));
  const stat = new Map();
  for (const m of materials) { const st = stat.get(m.trade_id) || { total: 0, low: 0 }; st.total++; const rt = Number(m.reorder_threshold); if (rt > 0 && (onHand.get(m.id) || 0) <= rt) st.low++; stat.set(m.trade_id, st); }
  app.innerHTML = header("#/") + `<h1>Trades</h1><p class="sub">Pick a trade to see its materials, stock, and locations — or clock materials out.</p>
    <div class="grid two" style="margin-top:16px">${trades.map((t) => {
      const st = stat.get(t.id) || { total: 0, low: 0 };
      return `<a class="card tap" href="#/trade/${t.id}"><div><div class="title">${esc(t.name)}</div><div class="meta">${st.total} material${st.total === 1 ? "" : "s"}</div></div>${st.low ? `<span class="badge amber">${st.low} low</span>` : `<span class="muted">→</span>`}</a>`;
    }).join("")}</div>`;
}

async function viewTrade(tradeId) {
  const s = getSession();
  if (s.role !== "admin" && s.role !== "superintendent" && s.tradeId !== tradeId) { toast("You can only access your own trade."); location.hash = "#/"; return; }
  const trade = await readTrade(tradeId);
  if (!trade) { app.innerHTML = header("#/") + `<div class="box">Trade not found.</div>`; return; }
  const materials = await readMaterialsWithStock(tradeId);

  function render_() {
    const matRow = (m) => {
      const total = m.locations.reduce((a, l) => a + l.qty, 0);
      const low = Number(m.reorder_threshold) > 0 && total <= Number(m.reorder_threshold);
      return `<div class="row ${low ? "low" : ""}">
        <div><div class="name">${esc(m.name)}</div><div class="meta">${m.locations.length ? m.locations.map((l) => `${esc(l.name)}: ${fmt(l.qty)} ${esc(m.unit)}`).join(" · ") : "No stock recorded"}</div></div>
        <div style="text-align:right"><div class="${low ? "low-val" : ""}" style="font-weight:600">${fmt(total)} ${esc(m.unit)}</div>
          <button class="sm outline" data-take="${m.id}">Take</button></div>
      </div>`;
    };
    const phaseOrder = [["Rough-In", "Rough-In"], ["Trim", "Trim"], [null, "Other"]];
    const groups = [];
    for (const [ph, plabel] of phaseOrder) {
      const inPhase = materials.filter((m) => (m.phase || null) === ph);
      if (!inPhase.length) continue;
      const cats = [...new Set(inPhase.map((m) => m.category || "General"))].sort();
      groups.push({ label: plabel, cats: cats.map((c) => ({ name: c, items: inPhase.filter((m) => (m.category || "General") === c) })) });
    }
    const backTab = s.role === "admin" ? "#/" : null;
    app.innerHTML = header(backTab || "#/") + `
      ${backTab ? `<a href="#/" class="muted" style="font-size:12px">← All trades</a>` : ""}
      <h1>${esc(trade.name)}</h1><p class="sub">Tap a material, pick how many, and it's clocked out. You can't take more than what's on hand.</p>
      ${groups.map((g) => `<h2>${esc(g.label)}</h2>${g.cats.map((c) => `${(g.cats.length > 1 || c.name !== "General") ? `<div class="cat-label">${esc(c.name)}</div>` : ""}<div class="list" style="margin-bottom:14px">${c.items.map(matRow).join("")}</div>`).join("")}`).join("") || `<div class="box">No materials set up for this trade yet.</div>`}
      <div id="takepanel"></div>`;

    app.querySelectorAll("[data-take]").forEach((b) => (b.onclick = () => openTake(b.dataset.take)));
  }

  function openTake(mid) {
    const m = materials.find((x) => x.id === mid);
    const panel = document.getElementById("takepanel");
    // The panel opens as a bottom-sheet pinned to the viewport (not at the foot of the
    // page), so it's in view right where the thumb is no matter how far down the tapped
    // material sits. Closes on the ✕, a tap on the dim backdrop, or after adding.
    const closeTake = () => { panel.innerHTML = ""; };
    const wireClose = () => {
      document.getElementById("tk-close").onclick = closeTake;
      document.getElementById("tk-sheet").addEventListener("click", (e) => { if (e.target.id === "tk-sheet") closeTake(); });
    };
    const sheetHead = `<div class="sheet-head"><b>${esc(m.name)}</b><button type="button" class="sheet-x" id="tk-close" aria-label="Close">✕</button></div>`;
    if (!m.locations.length) {
      panel.innerHTML = `<div class="sheet-backdrop" id="tk-sheet"><div class="sheet">${sheetHead}<div class="box amber" style="margin-top:2px">No stock or location on record for this yet. Use “Request” once an owner adds a location.</div></div></div>`;
      wireClose(); return;
    }
    // How many are on hand at a location.
    const availAt = (lid) => Math.max(0, m.locations.find((l) => l.locationId === lid)?.qty || 0);
    panel.innerHTML = `<div class="sheet-backdrop" id="tk-sheet"><div class="sheet" role="dialog" aria-modal="true">${sheetHead}
      <div><label>From location</label><select id="tk-loc">${m.locations.map((l) => `<option value="${l.locationId}">${esc(l.name)} (${fmt(l.qty)} ${esc(m.unit)})</option>`).join("")}</select></div>
      <div style="margin-top:12px"><label>Qty (${esc(m.unit)})</label>
        <div class="stepper">
          <button type="button" class="step" id="tk-minus" aria-label="Take one fewer">−</button>
          <input id="tk-qty" type="number" min="0" step="any" inputmode="decimal" value="1" />
          <button type="button" class="step" id="tk-plus" aria-label="Take one more">+</button>
        </div>
        <button type="button" class="step-max" id="tk-max">Take max on hand (<span id="tk-maxn">${fmt(availAt(m.locations[0].locationId))}</span>)</button>
      </div>
      <div style="margin-top:16px"><button class="block" id="tk-add">Clock out</button></div>
      <div id="tk-msg"></div><div id="reqpanel"></div></div></div>`;
    wireClose();

    const qtyEl = document.getElementById("tk-qty");
    const locEl = document.getElementById("tk-loc");
    const maxnEl = document.getElementById("tk-maxn");
    const minusEl = document.getElementById("tk-minus");
    const plusEl = document.getElementById("tk-plus");
    const maxEl = document.getElementById("tk-max");
    const curMax = () => availAt(locEl.value);
    // Grey out a key when it can't do anything, so it's always clear what's tappable:
    // − off at 0, ＋ and Max off once you're at what's on hand.
    const sync = () => {
      const mx = curMax(); const v = Number(qtyEl.value) || 0;
      maxnEl.textContent = fmt(mx);
      minusEl.disabled = v <= 0;
      plusEl.disabled = v >= mx;
      maxEl.disabled = mx <= 0 || v >= mx;
    };
    const setQty = (n) => { qtyEl.value = fmt(!isFinite(n) || n < 0 ? 0 : n); sync(); };
    // +/- move by whole units and never push past what's on hand; typing is still free
    // (typing more than on hand routes into the "request more" flow on Add).
    // Returns false when it hit a limit and nothing changed, so a hold can stop itself.
    const bump = (d) => { const before = Math.floor(Number(qtyEl.value) || 0); let n = before + d; if (n < 0) n = 0; if (d > 0 && n > curMax()) n = curMax(); setQty(n); return n !== before; };
    qtyEl.addEventListener("input", sync);
    locEl.onchange = () => { if ((Number(qtyEl.value) || 0) > curMax()) setQty(curMax()); else sync(); };

    // Tap to step once; press-and-hold to scroll the count quickly (stops at the limit).
    let holdT, holdI;
    const stopHold = () => { clearTimeout(holdT); clearInterval(holdI); };
    const startHold = (d) => { if (!bump(d)) return; holdT = setTimeout(() => { holdI = setInterval(() => { if (!bump(d)) stopHold(); }, 75); }, 350); };
    const wireHold = (el, d) => {
      el.addEventListener("mousedown", (e) => { e.preventDefault(); startHold(d); });
      el.addEventListener("touchstart", (e) => { e.preventDefault(); startHold(d); }, { passive: false });
      ["mouseup", "mouseleave", "touchend", "touchcancel"].forEach((ev) => el.addEventListener(ev, stopHold));
    };
    wireHold(minusEl, -1);
    wireHold(plusEl, 1);
    maxEl.onclick = () => setQty(curMax());
    sync();

    // One tap records this item straight away — no separate submit step.
    document.getElementById("tk-add").onclick = async () => {
      const lid = locEl.value;
      const loc = m.locations.find((l) => l.locationId === lid);
      const qty = Number(qtyEl.value);
      const msg = document.getElementById("tk-msg");
      const btn = document.getElementById("tk-add");
      if (!qty || qty <= 0) { msg.innerHTML = `<div class="notice error">Enter a quantity above 0.</div>`; return; }
      if (qty > loc.qty) { msg.innerHTML = `<div class="notice error">Only ${fmt(Math.max(loc.qty, 0))} ${esc(m.unit)} on hand at ${esc(loc.name)}.</div>`; openRequest(m, loc, Math.max(qty - Math.max(loc.qty, 0), 1)); return; }
      btn.disabled = true; btn.textContent = "Clocking out…";
      const clientUuid = crypto.randomUUID();
      const lines = [{ materialId: m.id, locationId: lid, quantity: qty }];
      const finish = (offline) => {
        loc.qty = Math.max(0, loc.qty - qty); // reflect the take on the trade list right away
        render_(); // rebuilds the page, which also closes the sheet
        toast(offline ? `Saved offline · ${fmt(qty)} ${esc(m.unit)} ${esc(m.name)}` : `Clocked out ${fmt(qty)} ${esc(m.unit)} · ${esc(m.name)}`);
      };
      if (!navigator.onLine) { await queuePut({ clientUuid, tradeId, notes: "", lines, createdAt: Date.now() }); finish(true); updateNet(); return; }
      try {
        const r = await apiCall("clock_out", { tradeId, notes: "", lines, clientUuid });
        if (r.ok) finish(false); else { btn.disabled = false; btn.textContent = "Clock out"; }
      } catch (e) {
        if (e.code === "insufficient_stock") { msg.innerHTML = `<div class="notice error">Someone took some first — refresh to see current stock.</div>`; btn.disabled = false; btn.textContent = "Clock out"; }
        else if (e.status) { msg.innerHTML = `<div class="notice error">${esc(e.message)}</div>`; btn.disabled = false; btn.textContent = "Clock out"; }
        else { await queuePut({ clientUuid, tradeId, notes: "", lines, createdAt: Date.now() }); finish(true); updateNet(); } // network drop
      }
    };
  }

  function openRequest(m, loc, qty) {
    const panel = document.getElementById("reqpanel");
    panel.innerHTML = `<div class="box amber"><b>Not enough on hand.</b><div class="sub">Send management a request for ${esc(m.name)} — the form lets you add a photo, Lowe's link/SKU, why it's needed, and whether it's a takeoff shortfall.</div>
      <div class="spacer"></div><button class="amber" id="rq-go">Request ${fmt(qty)} ${esc(m.unit)} →</button> <button class="link" id="rq-cancel">Cancel</button></div>`;
    document.getElementById("rq-cancel").onclick = () => (panel.innerHTML = "");
    document.getElementById("rq-go").onclick = () => { location.hash = `#/request?item=${encodeURIComponent(m.name)}&qty=${qty}`; render(); };
  }

  render_();
}

async function viewInventory() {
  app.innerHTML = header("#/admin/inventory") + `<h1>Inventory</h1><p class="sub">Live — updates as materials are clocked out.</p>
    <div class="inline" style="margin:12px 0">
      <div><select id="tfilter"><option value="">All trades</option></select></div>
      <div><select id="cfilter"><option value="">All categories</option></select></div>
    </div>
    <div id="invlist" class="center muted">Loading…</div>`;
  const { data } = await sb.from("inventory_items").select("quantity_on_hand,material_id,location_id,materials(name,unit,phase,category,reorder_threshold,trades(name)),locations(name)");
  let rows = (data || []).map((r) => ({ materialId: r.material_id, locationId: r.location_id, material: r.materials?.name || "—", unit: r.materials?.unit || "ea", phase: r.materials?.phase || "", category: r.materials?.category || "Other", trade: r.materials?.trades?.name || "—", location: r.locations?.name || "—", qty: Number(r.quantity_on_hand), reorder: Number(r.materials?.reorder_threshold ?? 0) }));
  const tf = document.getElementById("tfilter");
  [...new Set(rows.map((r) => r.trade))].sort().forEach((t) => tf.insertAdjacentHTML("beforeend", `<option>${esc(t)}</option>`));
  const cf = document.getElementById("cfilter");
  [...new Set(rows.map((r) => r.category))].sort().forEach((c) => cf.insertAdjacentHTML("beforeend", `<option>${esc(c)}</option>`));
  const draw = () => {
    const t = tf.value, c = cf.value;
    const shown = rows.filter((r) => (!t || r.trade === t) && (!c || r.category === c));
    // one line per material (summed across locations)
    const byMat = new Map();
    for (const r of shown) {
      const e = byMat.get(r.materialId) || { material: r.material, unit: r.unit, trade: r.trade, phase: r.phase, category: r.category, reorder: r.reorder, qty: 0, locs: [] };
      e.qty += r.qty;
      if (r.qty !== 0) e.locs.push({ name: r.location, qty: r.qty });
      byMat.set(r.materialId, e);
    }
    const groups = new Map();
    for (const m of byMat.values()) {
      const key = [m.trade, m.phase, m.category].filter(Boolean).join(" · ");
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(m);
    }
    const sorted = [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    document.getElementById("invlist").innerHTML = sorted.length
      ? sorted.map(([label, ms]) => `<div class="cat-label">${esc(label)}</div><div class="list" style="margin-bottom:14px">${ms.sort((a, b) => a.material.localeCompare(b.material)).map((m) => {
          const low = m.reorder > 0 && m.qty <= m.reorder;
          return `<div class="row ${low ? "low" : ""}"><div style="min-width:0"><div class="name">${esc(m.material)}</div>${m.locs.length > 1 ? `<div class="meta">${m.locs.map((l) => `${esc(l.name)}: ${fmt(l.qty)}`).join(" · ")}</div>` : ""}</div><div class="${low ? "low-val" : ""}" style="font-weight:600;white-space:nowrap">${fmt(m.qty)} ${esc(m.unit)}</div></div>`;
        }).join("")}</div>`).join("")
      : `<div class="box muted">Nothing here yet.</div>`;
  };
  tf.onchange = draw; cf.onchange = draw; draw();
  sb.channel("inv-live").on("postgres_changes", { event: "*", schema: "materials", table: "inventory_items" }, (p) => {
    const u = p.new; if (!u?.material_id) return;
    const row = rows.find((r) => r.materialId === u.material_id && r.locationId === u.location_id);
    if (row) { row.qty = Number(u.quantity_on_hand); draw(); }
  }).subscribe();
}

// Shrink a chosen photo client-side (phones take huge files) before upload.
function resizePhoto(file, maxDim = 1280, quality = 0.7) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width: w, height: h } = img;
      if (w > h && w > maxDim) { h = Math.round((h * maxDim) / w); w = maxDim; }
      else if (h > maxDim) { w = Math.round((w * maxDim) / h); h = maxDim; }
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      resolve(c.toDataURL("image/jpeg", quality).split(",")[1]);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// The request form — anyone can open it (field or office).
async function viewRequestForm() {
  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  const prefill = q.get("item") || "";
  const prefillQty = q.get("qty") || "";
  let photoB64 = null;
  app.innerHTML = header("#/request") + `<h1>Request a material</h1>
    <p class="sub">This goes to management as an order request. Be specific so they can order the right thing.</p>
    <div class="box">
      <div class="field"><label>What's needed</label><input id="rq-title" value="${esc(prefill)}" placeholder="e.g. 2-gang PVC fire-rated box" /></div>
      <div class="field"><label>How many</label><input id="rq-qty" type="number" min="1" step="any" value="${esc(prefillQty)}" /></div>
      <div class="field"><label>Photo of what's needed</label>
        <input id="rq-photo" type="file" accept="image/*" capture="environment" />
        <div id="rq-preview"></div></div>
      <div class="inline">
        <div class="grow2"><label>Vendor link (optional)</label><input id="rq-link" type="url" inputmode="url" placeholder="Lowe's, Home Depot, supplier… any link" /></div>
        <div><label>SKU / item #</label><input id="rq-sku" placeholder="e.g. 2987584" /></div>
      </div>
      <div class="field" style="margin-top:12px"><label>Why is this needed?</label><textarea id="rq-why" placeholder="What it's for + where — e.g. Floor 3 rooms 301–320 rough-in"></textarea></div>
      <div class="field"><label>Are we short from the takeoff?</label>
        <select id="rq-short"><option value="no">No — good to go</option><option value="yes">Yes — we're short</option></select></div>
      <div class="field" id="rq-explainwrap" style="display:none"><label>Explain the shortfall</label><textarea id="rq-explain" placeholder="Why the takeoff came up short — e.g. takeoff counted 300 boxes but there are 320 rooms"></textarea></div>
      <div id="rq-msg"></div>
      <button class="block" id="rq-go">Send request</button>
    </div>`;

  const shortSel = document.getElementById("rq-short");
  shortSel.onchange = () => { document.getElementById("rq-explainwrap").style.display = shortSel.value === "yes" ? "block" : "none"; };
  const photoInput = document.getElementById("rq-photo");
  photoInput.onchange = async () => {
    const f = photoInput.files[0];
    if (!f) { photoB64 = null; document.getElementById("rq-preview").innerHTML = ""; return; }
    document.getElementById("rq-preview").innerHTML = `<div class="muted" style="font-size:13px;margin-top:6px">Compressing photo…</div>`;
    try { photoB64 = await resizePhoto(f); document.getElementById("rq-preview").innerHTML = `<img src="data:image/jpeg;base64,${photoB64}" style="margin-top:8px;max-height:160px;border-radius:6px;border:1px solid var(--stone-line)" />`; }
    catch { photoB64 = null; document.getElementById("rq-preview").innerHTML = `<div class="notice error">Couldn't read that image.</div>`; }
  };

  document.getElementById("rq-go").onclick = async () => {
    const btn = document.getElementById("rq-go"); const msg = document.getElementById("rq-msg");
    const short = shortSel.value === "yes";
    btn.disabled = true; btn.textContent = "Sending…";
    try {
      await requestCall("create_request", {
        title: document.getElementById("rq-title").value,
        quantity: Number(document.getElementById("rq-qty").value),
        why: document.getElementById("rq-why").value,
        lowesLink: document.getElementById("rq-link").value,
        sku: document.getElementById("rq-sku").value,
        takeoffShort: short,
        takeoffExplain: short ? document.getElementById("rq-explain").value : "",
        photoBase64: photoB64,
        photoMime: "image/jpeg",
      });
      app.innerHTML = header("#/request") + `<div class="box green"><h2 style="margin-top:0">Request sent ✓</h2><p>Management will see it under Requests. Thanks for the detail.</p><div class="spacer"></div><button id="again">Request something else</button></div>`;
      document.getElementById("again").onclick = () => { location.hash = "#/request"; render(); };
    } catch (e) { msg.innerHTML = `<div class="notice error">${esc(e.message)}</div>`; btn.disabled = false; btn.textContent = "Send request"; }
  };
}

// Admin worklist — the order-placement queue.
async function viewRequests() {
  const q = new URLSearchParams(location.hash.split("?")[1] || "");
  const status = q.get("status") || "open";
  const takeoffOnly = q.get("takeoff") === "1";
  const { requests } = await requestCall("list_requests", { status, takeoffOnly });
  const badge = { open: "amber", ordered: "blue", fulfilled: "green", cancelled: "grey" };
  const cards = requests.length ? requests.map((r) => `
    <div class="box" style="margin-top:12px">
      <div style="display:flex;gap:14px">
        ${r.photo_url ? `<a href="${esc(r.photo_url)}" target="_blank" rel="noopener"><img src="${esc(r.photo_url)}" style="width:76px;height:76px;object-fit:cover;border-radius:6px;border:1px solid var(--stone-line)" /></a>` : `<div style="width:76px;height:76px;border-radius:6px;border:1px dashed var(--stone-line);display:flex;align-items:center;justify-content:center;color:var(--stone);font-size:11px;text-align:center">no photo</div>`}
        <div style="flex:1;min-width:0">
          <div class="name" style="font-family:var(--serif);font-size:18px">${fmt(r.quantity)} · ${esc(r.material_name)}
            <span class="badge ${badge[r.status]}">${r.status}</span>${r.takeoff_short ? `<span class="badge" style="background:var(--brick);color:#fff">takeoff short</span>` : ""}</div>
          <div class="meta">${esc(r.workers?.name || "—")}${r.trades?.name ? " · " + esc(r.trades.name) : ""} · ${new Date(r.created_at).toLocaleDateString()}</div>
          <div style="margin-top:6px;font-size:14px"><b>Why:</b> ${esc(r.why || "—")}</div>
          ${r.takeoff_short && r.takeoff_explain ? `<div style="font-size:14px;color:var(--brick)"><b>Shortfall:</b> ${esc(r.takeoff_explain)}</div>` : ""}
          <div class="meta" style="margin-top:6px">${r.sku ? "SKU " + esc(r.sku) : ""}${r.lowes_link ? ` · <a href="${esc(r.lowes_link)}" target="_blank" rel="noopener">Vendor link ↗</a>` : ""}</div>
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;margin-top:12px">
        ${r.status !== "ordered" && r.status !== "fulfilled" ? `<button class="sm outline" data-set="${r.id}" data-status="ordered">Mark ordered</button>` : ""}
        ${r.status !== "fulfilled" ? `<button class="sm outline" data-set="${r.id}" data-status="fulfilled">Received</button>` : ""}
        ${r.status !== "cancelled" && r.status !== "fulfilled" ? `<button class="sm outline" data-set="${r.id}" data-status="cancelled">Cancel</button>` : ""}
      </div>
    </div>`).join("") : `<div class="box muted">No ${status === "all" ? "" : status}${takeoffOnly ? " takeoff-shortfall" : ""} requests.</div>`;
  app.innerHTML = header("#/admin/requests") + `<h1>Requests</h1><p class="sub">Order worklist — everything management needs to place the order.</p>
    <a href="#/request" style="display:inline-block;background:var(--ink);color:var(--paper-2);padding:10px 16px;border-radius:var(--radius);font-size:14px;font-weight:600;margin:10px 0">＋ New request</a>
    <nav class="tabs" style="margin:10px 0">${["open", "ordered", "fulfilled", "cancelled", "all"].map((t) => `<a href="#/admin/requests?status=${t}${takeoffOnly ? "&takeoff=1" : ""}" class="${t === status ? "active" : ""}">${t}</a>`).join("")}
      <a href="#/admin/requests?status=${status}${takeoffOnly ? "" : "&takeoff=1"}" class="${takeoffOnly ? "active" : ""}" style="margin-left:8px">⚠ takeoff shortfalls</a></nav>
    <div id="rq">${cards}</div>`;
  app.querySelectorAll("[data-set]").forEach((b) => (b.onclick = async () => { try { await requestCall("set_request_status", { id: b.dataset.set, status: b.dataset.status }); render(); } catch (e) { toast(e.message); } }));
}

async function viewActivity() {
  const { clockouts, deliveries } = await apiCall("list_activity");
  const mapItems = (arr) => (arr || []).map((l) => ({ qty: l.quantity, name: l.materials?.name || "", unit: l.materials?.unit || "", loc: l.locations?.name || "" }));
  const events = [
    ...clockouts.map((c) => {
      const items = mapItems(c.clockout_line_items);
      return { t: c.created_at, kind: "out", title: `${c.workers?.name || "—"} took ${items.length} item${items.length === 1 ? "" : "s"}`, trade: c.trades?.name || "", note: c.notes || "", items };
    }),
    ...deliveries.map((d) => {
      const items = mapItems(d.delivery_line_items);
      return { t: d.created_at, kind: "in", title: `Delivery — ${d.source}`, trade: d.trades?.name || "", note: d.po_number ? "PO " + d.po_number : "", items };
    }),
  ].sort((a, b) => new Date(b.t) - new Date(a.t));

  const dayKey = (t) => new Date(t).toLocaleDateString(undefined, { weekday: "long", month: "short", day: "numeric" });
  const timeOf = (t) => new Date(t).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const groups = [];
  for (const e of events) { const k = dayKey(e.t); let g = groups.find((x) => x.day === k); if (!g) { g = { day: k, rows: [] }; groups.push(g); } g.rows.push(e); }

  app.innerHTML = header("#/admin") + `<h1>Activity</h1><p class="sub">Tap an entry to see the items.</p>
    ${groups.length ? groups.map((g) => `<h2>${esc(g.day)}</h2><div class="list" style="margin-bottom:14px">${g.rows.map((e) => `
      <div class="row act-sum" style="cursor:pointer">
        <div style="min-width:0">
          <div class="name">${esc(e.title)}${e.trade ? ` <span class="muted" style="font-weight:400">· ${esc(e.trade)}</span>` : ""}</div>
          <div class="meta">${esc(timeOf(e.t))}${e.note ? ` · ${esc(e.note)}` : ""}</div>
        </div>
        <span style="white-space:nowrap"><span class="badge ${e.kind === "in" ? "green" : "grey"}">${e.kind === "in" ? "in" : "out"}</span> <span class="chev muted">▾</span></span>
      </div>
      <div class="act-detail" style="display:none;padding:2px 16px 12px;background:#F1EAD9">${e.items.length ? e.items.map((it) => `<div class="meta" style="padding:3px 0;font-size:13px">${fmt(it.qty)} ${esc(it.unit)} · ${esc(it.name)}${it.loc ? ` <span class="muted">(${esc(it.loc)})</span>` : ""}</div>`).join("") : `<div class="meta">No items recorded.</div>`}</div>`).join("")}</div>`).join("") : `<div class="box muted">No activity yet.</div>`}`;

  app.querySelectorAll(".act-sum").forEach((el) => {
    el.onclick = () => {
      const d = el.nextElementSibling;
      const open = d.style.display !== "none";
      d.style.display = open ? "none" : "block";
      const chev = el.querySelector(".chev");
      if (chev) chev.textContent = open ? "▾" : "▴";
    };
  });
}

async function viewDeliveries() {
  const batchId = new URLSearchParams(location.hash.split("?")[1] || "").get("batch");
  if (batchId) return viewImportBatch(batchId);

  const { batches } = await importCall("list_imports");
  const count = (b) => (b.import_lines && b.import_lines[0] ? b.import_lines[0].count : 0);
  const published = batches.filter((b) => b.status === "published");
  app.innerHTML = header("#/admin") + `<h1>Deliveries</h1>
    <p class="sub">Received materials are pulled from your procurement folder (per trade) straight into inventory. History below.</p>
    ${published.length
      ? `<div class="list" style="margin-top:12px">${published.map((b) => `<a class="row" href="#/admin/deliveries?batch=${b.id}"><div><div class="name">${esc(b.label)}</div><div class="meta">${count(b)} items${b.published_at ? " · " + new Date(b.published_at).toLocaleDateString() : ""}${b.trades?.name ? " · " + esc(b.trades.name) : ""}</div></div><span class="badge green">added →</span></a>`).join("")}</div>`
      : `<div class="box muted">No deliveries pulled in yet. When a tracker is confirmed, tell Claude and it pulls the received items into inventory.</div>`}`;
}

async function viewImportBatch(id) {
  const [{ batch, lines }, locations] = await Promise.all([importCall("get_import", { id }), readLocations()]);
  if (!batch) { app.innerHTML = header("#/admin") + `<div class="box">Batch not found.</div>`; return; }
  const published = batch.status !== "pending";

  function render_() {
    const included = lines.filter((l) => l.include).length;
    app.innerHTML = header("#/admin") + `
      <a href="#/admin/deliveries" class="muted" style="font-size:12px">← Deliveries</a>
      <h1>${esc(batch.label)}</h1>
      <p class="sub">${esc(batch.trades?.name || "")} · ${lines.length} received line${lines.length === 1 ? "" : "s"} from ${esc(batch.source || "tracker")}. Uncheck anything you don't want, then publish.</p>
      ${published
        ? `<div class="box green">This batch was ${esc(batch.status)}.</div>`
        : `<div class="inline" style="margin:10px 0"><div class="grow2"><label>Store received items at</label><select id="pub-loc">${locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join("")}</select></div>
           <div style="flex:0;align-self:end"><button id="pub-go">Publish ${included} to inventory</button></div></div><div id="pub-msg"></div>`}
      <div class="tablewrap" style="margin-top:10px"><table><thead><tr><th></th><th>Item</th><th class="num">Qty</th><th>Unit</th><th>Order / shipment</th><th>Notes</th></tr></thead>
        <tbody>${lines.map((l) => `<tr class="${l.include ? "" : "muted"}"><td>${published ? "" : `<input type="checkbox" data-inc="${l.id}" ${l.include ? "checked" : ""} style="width:auto;min-height:0" />`}</td>
          <td>${esc(l.item_name)}</td><td class="num">${fmt(l.quantity)}</td><td>${esc(l.unit)}</td><td class="meta">${esc((l.order_ref || "").slice(0, 22))}</td><td class="meta">${esc(l.notes || "")}</td></tr>`).join("")}</tbody></table></div>
      ${published ? "" : `<div class="spacer"></div><button class="link" id="discard">Discard this batch</button>`}`;

    if (published) return;
    app.querySelectorAll("[data-inc]").forEach((cb) => (cb.onchange = async () => {
      const line = lines.find((x) => x.id === cb.dataset.inc);
      line.include = cb.checked;
      document.getElementById("pub-go").textContent = `Publish ${lines.filter((l) => l.include).length} to inventory`;
      try { await importCall("set_import_line", { lineId: cb.dataset.inc, include: cb.checked }); } catch (e) { toast(e.message); }
    }));
    document.getElementById("pub-go").onclick = async () => {
      const btn = document.getElementById("pub-go"); btn.disabled = true; btn.textContent = "Publishing…";
      try {
        const r = await importCall("publish_import", { id, locationId: document.getElementById("pub-loc").value });
        document.getElementById("pub-msg").innerHTML = `<div class="notice ok">Published ${r.published} items into inventory. Redirecting…</div>`;
        setTimeout(() => { location.hash = "#/admin/inventory"; render(); }, 1000);
      } catch (e) { document.getElementById("pub-msg").innerHTML = `<div class="notice error">${esc(e.message)}</div>`; btn.disabled = false; }
    };
    document.getElementById("discard").onclick = async () => {
      if (!confirm("Discard this batch? Nothing goes to inventory.")) return;
      try { await importCall("discard_import", { id }); location.hash = "#/admin/deliveries"; render(); } catch (e) { toast(e.message); }
    };
  }
  render_();
}

async function viewSettings() {
  const [trades, locations, materials, workers] = await Promise.all([
    readTrades(), readLocations(),
    sb.from("materials").select("id,name,unit,phase,reorder_threshold,trades(name)").order("name").then((r) => r.data || []),
    readWorkers(),
  ]);
  const tOpts = trades.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
  app.innerHTML = header("#/admin") + `<h1>Settings</h1><p class="sub">Manage trades, locations, materials, and workers.</p>
    <h2>Trades</h2><div class="list">${trades.map((t) => `<div class="row"><span>${esc(t.name)}</span></div>`).join("")}</div>
    <div class="inline" style="margin-top:8px"><input id="t-name" placeholder="New trade" /><button class="ghost" data-add="add_trade">Add</button></div>

    <h2>Locations</h2><div class="list">${locations.map((l) => `<div class="row"><span>${esc(l.name)}${l.description ? ` <span class="muted">— ${esc(l.description)}</span>` : ""}</span></div>`).join("")}</div>
    <div class="inline" style="margin-top:8px"><input id="l-name" placeholder="Location" /><input id="l-desc" placeholder="Description (optional)" /><button class="ghost" data-add="add_location">Add</button></div>

    <h2>Materials</h2><div class="list">${materials.map((m) => `<div class="row"><span>${esc(m.name)} <span class="muted">· ${esc(m.trades?.name || "")}${m.phase ? " · " + esc(m.phase) : ""} · reorder ${fmt(m.reorder_threshold)} ${esc(m.unit)}</span></span></div>`).join("")}</div>
    <div class="inline" style="margin-top:8px"><select id="m-trade"><option value="">Trade…</option>${tOpts}</select><input id="m-name" placeholder="Material" /><input id="m-unit" placeholder="Unit" value="ea" style="flex:.5" />
    <select id="m-phase" style="flex:.8"><option value="">No phase</option><option>Rough-In</option><option>Trim</option></select><input id="m-reorder" type="number" min="0" placeholder="Reorder" value="0" style="flex:.6" /><button class="ghost" data-add="add_material">Add</button></div>

    <h2>Workers</h2><div class="list">${workers.map((w) => `<div class="row"><div><span class="name" style="${!w.active ? "text-decoration:line-through;color:#94a3b8" : ""}">${esc(w.name)}</span> <span class="muted">· ${w.role === "admin" ? "owner" : w.role === "superintendent" ? "super" : "sub"}${w.trades?.name ? " · " + esc(w.trades.name) : ""}</span></div>
      <div style="display:flex;gap:4px">${w.active ? `<button class="sm outline" data-rename="${w.id}" data-name="${esc(w.name)}">Rename</button><button class="sm outline" data-pin="${w.id}" data-name="${esc(w.name)}">Set PIN</button><button class="sm outline" data-deact="${w.id}">Deactivate</button>` : ""}</div></div>`).join("")}</div>
    <div class="inline" style="margin-top:8px"><input id="w-name" placeholder="Full name" /><select id="w-trade"><option value="">No trade (owner)</option>${tOpts}</select>
    <select id="w-role" style="flex:.8"><option value="field_worker">Sub</option><option value="superintendent">Superintendent</option><option value="admin">Owner</option></select><input id="w-pin" placeholder="PIN (4-6 digits)" inputmode="numeric" style="flex:.7" /><button class="ghost" data-add="add_worker">Add</button></div>
    <div id="s-msg"></div>`;

  const val = (id) => document.getElementById(id).value;
  const run = async (fn) => { try { await fn(); render(); } catch (e) { document.getElementById("s-msg").innerHTML = `<div class="notice error">${esc(e.message)}</div>`; } };
  const map = {
    add_trade: () => apiCall("add_trade", { name: val("t-name") }),
    add_location: () => apiCall("add_location", { name: val("l-name"), description: val("l-desc") }),
    add_material: () => apiCall("add_material", { tradeId: val("m-trade"), name: val("m-name"), unit: val("m-unit"), phase: val("m-phase"), reorderThreshold: val("m-reorder") }),
    add_worker: () => apiCall("add_worker", { name: val("w-name"), tradeId: val("w-trade"), role: val("w-role"), pin: val("w-pin") }),
  };
  app.querySelectorAll("[data-add]").forEach((b) => (b.onclick = () => run(map[b.dataset.add])));
  app.querySelectorAll("[data-deact]").forEach((b) => (b.onclick = () => run(() => apiCall("deactivate_worker", { id: b.dataset.deact }))));
  app.querySelectorAll("[data-rename]").forEach((b) => (b.onclick = () => { const n = prompt("New name for " + b.dataset.name + ":", b.dataset.name); if (n) run(() => apiCall("rename_worker", { id: b.dataset.rename, name: n })); }));
  app.querySelectorAll("[data-pin]").forEach((b) => (b.onclick = () => { const pin = prompt("New PIN for " + b.dataset.name + " (4-6 digits):"); if (pin) run(() => apiCall("set_pin", { id: b.dataset.pin, pin })); }));
}

async function viewAdminHub() {
  const isAdmin = getSession()?.role === "admin";
  app.innerHTML = header("#/admin") + `<h1>Admin</h1><p class="sub">Deliveries, activity${isAdmin ? ", and settings" : ""}.</p>
    <div class="grid two" style="margin-top:16px">
      <a class="card tap" href="#/admin/deliveries"><div><div class="title">Deliveries</div><div class="meta">Pulled from procurement — history</div></div><span class="muted">→</span></a>
      <a class="card tap" href="#/admin/activity"><div><div class="title">Activity</div><div class="meta">Clock-outs &amp; deliveries</div></div><span class="muted">→</span></a>
      ${isAdmin ? `<a class="card tap" href="#/admin/settings"><div><div class="title">Settings</div><div class="meta">Trades, locations, materials, workers</div></div><span class="muted">→</span></a>` : ""}
    </div>`;
}

async function viewAccount() {
  app.innerHTML = header("#/account") + `<h1>My PIN</h1><p class="sub">Change your own PIN.</p>
    <div class="box"><div class="field"><label>New PIN (4-6 digits)</label><input id="a-pin" inputmode="numeric" type="password" /></div><div id="a-msg"></div><button id="a-go">Update PIN</button></div>`;
  document.getElementById("a-go").onclick = async () => {
    try { await apiCall("set_pin", { pin: document.getElementById("a-pin").value }); document.getElementById("a-msg").innerHTML = `<div class="notice ok">PIN updated.</div>`; document.getElementById("a-pin").value = ""; }
    catch (e) { document.getElementById("a-msg").innerHTML = `<div class="notice error">${esc(e.message)}</div>`; }
  };
}

// ---- Router ----------------------------------------------------------------
async function render() {
  const s = getSession();
  const hash = location.hash || "#/";
  if (hash === "#/logout") { clearSession(); location.hash = "#/login"; return render(); }
  if (!validSession(s)) { if (hash !== "#/login") { location.hash = "#/login"; } await viewLogin(); return; }
  const path = hash.split("?")[0];
  const elevated = s.role === "admin" || s.role === "superintendent";
  const adminArea = path === "#/admin" || path.startsWith("#/admin/");
  if (adminArea && !elevated) { location.hash = "#/"; return render(); }
  // Settings stay owner-only, even for superintendents.
  if (path === "#/admin/settings" && s.role !== "admin") { location.hash = "#/admin"; return render(); }
  try {
    if (path === "#/login" || path === "#/") return await viewHome();
    if (path === "#/request") return await viewRequestForm();
    if (path.startsWith("#/trade/")) return await viewTrade(path.split("/")[2]);
    if (path === "#/admin") return await viewAdminHub();
    if (path === "#/admin/inventory") return await viewInventory();
    if (path === "#/admin/requests") return await viewRequests();
    if (path === "#/admin/activity") return await viewActivity();
    if (path === "#/admin/deliveries") return await viewDeliveries();
    if (path === "#/admin/settings") return await viewSettings();
    if (path === "#/account") return await viewAccount();
    return await viewHome();
  } catch (e) {
    app.innerHTML = header("#/") + `<div class="notice error">${esc(e.message || "Error loading this screen.")}</div>`;
  }
}

window.addEventListener("hashchange", render);
window.addEventListener("online", () => { flushQueue().then(updateNet); });
window.addEventListener("offline", updateNet);
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js").catch(() => {});
updateNet();
flushQueue();
render();
