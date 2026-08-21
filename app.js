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

async function apiCall(action, body = {}) {
  const s = getSession();
  const r = await fetch(FN + "/api", {
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

// ---- Direct reads ----------------------------------------------------------
async function readTrades() { return (await sb.from("trades").select("id,name").order("name")).data || []; }
async function readWorkersForLogin() { return (await sb.from("workers").select("id,name,role,trade_id").eq("active", true).order("name")).data || []; }
async function readWorkers() { return (await sb.from("workers").select("id,name,role,active,trade_id,trades(name)").order("name")).data || []; }
async function readLocations() { return (await sb.from("locations").select("id,name,description").order("name")).data || []; }
async function readTrade(id) { return (await sb.from("trades").select("id,name").eq("id", id).single()).data; }

async function readMaterialsWithStock(tradeId) {
  const materials = (await sb.from("materials").select("id,name,unit,phase,reorder_threshold").eq("trade_id", tradeId).order("name")).data || [];
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
  const admin = s?.role === "admin";
  const tab = (href, label) => `<a href="${href}" class="${active === href ? "active" : ""}">${label}</a>`;
  let tabs = "";
  if (admin) {
    tabs = [tab("#/", "Trades"), tab("#/admin/inventory", "Inventory"), tab("#/admin/requests", "Requests"),
      tab("#/admin/deliveries", "Delivery"), tab("#/admin/activity", "Activity"), tab("#/admin/settings", "Settings")].join("");
  } else {
    tabs = tab("#/account", "My PIN");
  }
  return `<header>
    <a class="wordmark" href="#/">
      <span class="mark">N</span>
      <span class="wm-lines"><span class="wm-eyebrow">Novel Construction</span><span class="wm-title">Site Materials</span></span>
    </a>
    <nav class="tabs">${tabs}<a href="#/logout">Log out</a></nav>
  </header>
  <div class="wholine">${esc(s?.name || "")} · ${esc(s?.role === "admin" ? "owner" : "field")}</div>`;
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
    <p class="muted" style="font-size:12px;margin-top:16px">First time? Owners "Milan" and "Co-Owner" start at PIN 0000 — change them in Settings.</p>
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
  // Field workers are scoped to their own trade — go straight there.
  if (s.role !== "admin") {
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
  for (const m of materials) { const st = stat.get(m.trade_id) || { total: 0, low: 0 }; st.total++; if ((onHand.get(m.id) || 0) <= Number(m.reorder_threshold)) st.low++; stat.set(m.trade_id, st); }
  app.innerHTML = header("#/") + `<h1>Trades</h1><p class="sub">Pick a trade to see its materials, stock, and locations — or clock materials out.</p>
    <div class="grid two" style="margin-top:16px">${trades.map((t) => {
      const st = stat.get(t.id) || { total: 0, low: 0 };
      return `<a class="card tap" href="#/trade/${t.id}"><div><div class="title">${esc(t.name)}</div><div class="meta">${st.total} material${st.total === 1 ? "" : "s"}</div></div>${st.low ? `<span class="badge amber">${st.low} low</span>` : `<span class="muted">→</span>`}</div></a>`;
    }).join("")}</div>`;
}

async function viewTrade(tradeId) {
  const s = getSession();
  if (s.role !== "admin" && s.tradeId !== tradeId) { toast("You can only access your own trade."); location.hash = "#/"; return; }
  const trade = await readTrade(tradeId);
  if (!trade) { app.innerHTML = header("#/") + `<div class="box">Trade not found.</div>`; return; }
  const materials = await readMaterialsWithStock(tradeId);

  const cart = []; // { materialId, name, unit, locationId, locationName, qty }
  const cartQtyFor = (mid, lid) => cart.filter((c) => c.materialId === mid && c.locationId === lid).reduce((a, c) => a + c.qty, 0);

  function render_() {
    const phases = [["Rough-In", "Rough-In"], ["Trim", "Trim"], [null, "Materials"]];
    const groups = phases.map(([ph, label]) => ({ label, items: materials.filter((m) => (m.phase || null) === ph) })).filter((g) => g.items.length);
    const backTab = s.role === "admin" ? "#/" : null;
    app.innerHTML = header(backTab || "#/") + `
      ${backTab ? `<a href="#/" class="muted" style="font-size:12px">← All trades</a>` : ""}
      <h1>${esc(trade.name)}</h1><p class="sub">Tap a material to take some. You can't take more than what's on hand.</p>
      ${groups.map((g) => `<h2>${g.label}</h2><div class="list">${g.items.map((m) => {
        const total = m.locations.reduce((a, l) => a + l.qty, 0);
        const low = total <= Number(m.reorder_threshold);
        return `<div class="row ${low ? "low" : ""}">
          <div><div class="name">${esc(m.name)}</div><div class="meta">${m.locations.length ? m.locations.map((l) => `${esc(l.name)}: ${fmt(l.qty)} ${esc(m.unit)}`).join(" · ") : "No stock recorded"}</div></div>
          <div style="text-align:right"><div class="${low ? "low-val" : ""}" style="font-weight:600">${fmt(total)} ${esc(m.unit)}</div>
            <button class="sm outline" data-take="${m.id}">Take</button></div>
        </div>`;
      }).join("")}</div>`).join("") || `<div class="box">No materials set up for this trade yet.</div>`}
      <div id="takepanel"></div>
      <div id="reqpanel"></div>
      ${cart.length ? `<div class="box"><b>Taking (${cart.length})</b>${cart.map((c, i) => `<div class="row"><div>${fmt(c.qty)} ${esc(c.unit)} · ${esc(c.name)} <span class="muted">from ${esc(c.locationName)}</span></div><button class="link" data-rm="${i}">Remove</button></div>`).join("")}</div>` : ""}
      <div id="msg"></div>
      <div class="cart-bar"><button class="block" id="submit" ${cart.length ? "" : "disabled"}>Submit clock-out (${cart.length} item${cart.length === 1 ? "" : "s"})</button></div>`;

    app.querySelectorAll("[data-take]").forEach((b) => (b.onclick = () => openTake(b.dataset.take)));
    app.querySelectorAll("[data-rm]").forEach((b) => (b.onclick = () => { cart.splice(Number(b.dataset.rm), 1); render_(); }));
    document.getElementById("submit").onclick = submit;
  }

  function openTake(mid) {
    const m = materials.find((x) => x.id === mid);
    const panel = document.getElementById("takepanel");
    document.getElementById("reqpanel").innerHTML = "";
    if (!m.locations.length) { panel.innerHTML = `<div class="box amber">No stock/location on record for ${esc(m.name)} yet. Use “Request” once an owner adds a location.</div>`; return; }
    panel.innerHTML = `<div class="box"><b>${esc(m.name)}</b>
      <div class="inline" style="margin-top:10px">
        <div class="grow2"><label>From location</label><select id="tk-loc">${m.locations.map((l) => `<option value="${l.locationId}">${esc(l.name)} (${fmt(l.qty)} ${esc(m.unit)})</option>`).join("")}</select></div>
        <div><label>Qty (${esc(m.unit)})</label><input id="tk-qty" type="number" min="0" step="any" value="1" /></div>
        <div style="flex:0"><label>&nbsp;</label><button id="tk-add">Add</button></div>
      </div><div id="tk-msg"></div></div>`;
    document.getElementById("tk-add").onclick = () => {
      const lid = document.getElementById("tk-loc").value;
      const loc = m.locations.find((l) => l.locationId === lid);
      const qty = Number(document.getElementById("tk-qty").value);
      const msg = document.getElementById("tk-msg");
      if (!qty || qty <= 0) { msg.innerHTML = `<div class="notice error">Enter a quantity above 0.</div>`; return; }
      const avail = loc.qty - cartQtyFor(m.id, lid);
      if (qty > avail) { msg.innerHTML = `<div class="notice error">Only ${fmt(Math.max(avail, 0))} ${esc(m.unit)} on hand at ${esc(loc.name)}.</div>`; openRequest(m, loc, Math.max(qty - Math.max(avail, 0), 1)); return; }
      cart.push({ materialId: m.id, name: m.name, unit: m.unit, locationId: lid, locationName: loc.name, qty });
      render_();
    };
  }

  function openRequest(m, loc, qty) {
    const panel = document.getElementById("reqpanel");
    panel.innerHTML = `<div class="box amber"><b>Request more stock</b><div class="sub">${esc(m.name)}${loc ? " · " + esc(loc.name) : ""}</div>
      <div class="inline" style="margin-top:10px"><div><label>How many (${esc(m.unit)})</label><input id="rq-qty" type="number" min="1" step="any" value="${qty}" /></div>
      <div class="grow2"><label>Note (optional)</label><input id="rq-note" placeholder="e.g. needed by Friday" /></div></div>
      <div id="rq-msg"></div><div class="spacer"></div><button class="amber" id="rq-go">Send request</button> <button class="link" id="rq-cancel">Cancel</button></div>`;
    document.getElementById("rq-cancel").onclick = () => (panel.innerHTML = "");
    document.getElementById("rq-go").onclick = async () => {
      const q = Number(document.getElementById("rq-qty").value);
      try {
        await apiCall("create_request", { tradeId, materialId: m.id, materialName: m.name, locationId: loc?.locationId || null, quantity: q, notes: document.getElementById("rq-note").value });
        panel.innerHTML = `<div class="notice ok">Requested ${fmt(q)} ${esc(m.unit)} of ${esc(m.name)}. Your owners will see it under Requests.</div>`;
      } catch (e) { document.getElementById("rq-msg").innerHTML = `<div class="notice error">${esc(e.message)}</div>`; }
    };
  }

  async function submit() {
    if (!cart.length) return;
    const btn = document.getElementById("submit"); btn.disabled = true; btn.textContent = "Submitting…";
    const clientUuid = crypto.randomUUID();
    const lines = cart.map((c) => ({ materialId: c.materialId, locationId: c.locationId, quantity: c.qty }));
    const done = (offline) => {
      app.innerHTML = header("#/") + `<div class="box ${offline ? "" : "green"}"><h2 style="margin-top:0">${offline ? "Saved offline ✓" : "Recorded ✓"}</h2>
        <p>${offline ? "Saved on this device — it'll sync when you're back online." : "Clock-out recorded for " + esc(getSession().name) + "."}</p>
        ${cart.map((c) => `<div class="row"><div>${fmt(c.qty)} ${esc(c.unit)} · ${esc(c.name)} <span class="muted">from ${esc(c.locationName)}</span></div></div>`).join("")}
        <div class="spacer"></div><button href="#" onclick="location.hash='#/trade/${tradeId}';location.reload()" id="again">Clock out more</button></div>`;
      document.getElementById("again").onclick = () => { location.hash = "#/trade/" + tradeId; render(); };
      updateNet();
    };
    if (!navigator.onLine) { await queuePut({ clientUuid, tradeId, notes: "", lines, createdAt: Date.now() }); done(true); return; }
    try {
      const r = await apiCall("clock_out", { tradeId, notes: "", lines, clientUuid });
      if (r.ok) done(false);
    } catch (e) {
      if (e.code === "insufficient_stock") { document.getElementById("msg").innerHTML = `<div class="notice error">Someone took some first — refresh to see current stock.</div>`; btn.disabled = false; btn.textContent = `Submit clock-out (${cart.length})`; }
      else if (e.status) { document.getElementById("msg").innerHTML = `<div class="notice error">${esc(e.message)}</div>`; btn.disabled = false; btn.textContent = `Submit clock-out (${cart.length})`; }
      else { await queuePut({ clientUuid, tradeId, notes: "", lines, createdAt: Date.now() }); done(true); } // network drop
    }
  }

  render_();
}

async function viewInventory() {
  app.innerHTML = header("#/admin/inventory") + `<h1>Inventory</h1><p class="sub">Live — updates as workers clock out.</p>
    <div class="inline" style="margin:12px 0"><div><select id="tfilter"><option value="">All trades</option></select></div>
    <label class="row" style="flex:0;border:none;padding:0;white-space:nowrap"><input type="checkbox" id="lowonly" style="width:auto" /> Low only</label></div>
    <div id="invtable"></div>`;
  const { data } = await sb.from("inventory_items").select("quantity_on_hand,material_id,location_id,materials(name,unit,phase,reorder_threshold,trades(name)),locations(name)").order("material_id");
  let rows = (data || []).map((r) => ({ materialId: r.material_id, locationId: r.location_id, material: r.materials?.name || "—", unit: r.materials?.unit || "ea", phase: r.materials?.phase || "", trade: r.materials?.trades?.name || "—", location: r.locations?.name || "—", qty: Number(r.quantity_on_hand), reorder: Number(r.materials?.reorder_threshold ?? 0) }));
  const tf = document.getElementById("tfilter");
  [...new Set(rows.map((r) => r.trade))].sort().forEach((t) => tf.insertAdjacentHTML("beforeend", `<option>${esc(t)}</option>`));
  const draw = () => {
    const t = tf.value, low = document.getElementById("lowonly").checked;
    const shown = rows.filter((r) => (!t || r.trade === t) && (!low || r.qty <= r.reorder)).sort((a, b) => a.trade.localeCompare(b.trade) || a.material.localeCompare(b.material));
    document.getElementById("invtable").innerHTML = `<div class="tablewrap"><table><thead><tr><th>Trade</th><th>Material</th><th>Phase</th><th>Location</th><th class="num">On hand</th></tr></thead>
      <tbody>${shown.map((r) => `<tr class="${r.qty <= r.reorder ? "low" : ""}"><td class="muted">${esc(r.trade)}</td><td>${esc(r.material)}</td><td class="muted">${esc(r.phase || "—")}</td><td>${esc(r.location)}</td><td class="num ${r.qty <= r.reorder ? "low-val" : ""}">${fmt(r.qty)} ${esc(r.unit)}</td></tr>`).join("") || `<tr><td colspan="5" class="center muted">Nothing matches.</td></tr>`}</tbody></table></div>`;
  };
  tf.onchange = draw; document.getElementById("lowonly").onchange = draw; draw();
  sb.channel("inv-live").on("postgres_changes", { event: "*", schema: "materials", table: "inventory_items" }, (p) => {
    const u = p.new; if (!u?.material_id) return;
    const row = rows.find((r) => r.materialId === u.material_id && r.locationId === u.location_id);
    if (row) { row.qty = Number(u.quantity_on_hand); draw(); }
  }).subscribe();
}

async function viewRequests() {
  const status = (location.hash.split("?")[1] || "").replace("status=", "") || "open";
  app.innerHTML = header("#/admin/requests") + `<h1>Requests</h1><p class="sub">Restock requests from the crew.</p>
    <nav class="tabs" style="margin:10px 0">${["open", "ordered", "fulfilled", "cancelled", "all"].map((t) => `<a href="#/admin/requests?status=${t}" class="${t === status ? "active" : ""}">${t}</a>`).join("")}</nav><div id="rq">Loading…</div>`;
  const { requests } = await apiCall("list_requests", { status });
  const badge = { open: "amber", ordered: "blue", fulfilled: "green", cancelled: "grey" };
  document.getElementById("rq").innerHTML = requests.length ? `<div class="list">${requests.map((r) => `<div class="row"><div><div class="name">${fmt(r.quantity)} · ${esc(r.material_name)} <span class="badge ${badge[r.status]}">${r.status}</span></div>
    <div class="meta">${esc(r.workers?.name || "—")}${r.trades?.name ? " · " + esc(r.trades.name) : ""}${r.locations?.name ? " · " + esc(r.locations.name) : ""} · ${new Date(r.created_at).toLocaleString()}</div>${r.notes ? `<div class="meta">“${esc(r.notes)}”</div>` : ""}</div>
    <div style="display:flex;gap:4px;flex-wrap:wrap">${r.status !== "ordered" && r.status !== "fulfilled" ? `<button class="sm outline" data-set="${r.id}" data-status="ordered">Ordered</button>` : ""}${r.status !== "fulfilled" ? `<button class="sm outline" data-set="${r.id}" data-status="fulfilled">Fulfilled</button>` : ""}${r.status !== "cancelled" && r.status !== "fulfilled" ? `<button class="sm outline" data-set="${r.id}" data-status="cancelled">Cancel</button>` : ""}</div></div>`).join("")}</div>` : `<div class="box muted">No ${status === "all" ? "" : status} requests.</div>`;
  app.querySelectorAll("[data-set]").forEach((b) => (b.onclick = async () => { try { await apiCall("set_request_status", { id: b.dataset.set, status: b.dataset.status }); render(); } catch (e) { toast(e.message); } }));
}

async function viewActivity() {
  app.innerHTML = header("#/admin/activity") + `<h1>Activity</h1><p class="sub">Clock-outs and deliveries.</p><div id="act">Loading…</div>`;
  const { clockouts, deliveries } = await apiCall("list_activity");
  const events = [
    ...clockouts.map((c) => ({ t: c.created_at, kind: "out", html: `<div class="name">${esc(c.workers?.name || "—")} took · <span class="muted">${esc(c.trades?.name || "")}</span></div><div class="meta">${(c.clockout_line_items || []).map((l) => `${fmt(l.quantity)} ${esc(l.materials?.unit || "")} ${esc(l.materials?.name || "")} (${esc(l.locations?.name || "")})`).join(" · ")}${c.notes ? " — “" + esc(c.notes) + "”" : ""}</div>` })),
    ...deliveries.map((d) => ({ t: d.created_at, kind: "in", html: `<div class="name">Delivery · ${esc(d.source)} <span class="muted">${esc(d.trades?.name || "")}</span></div><div class="meta">${d.po_number ? "PO " + esc(d.po_number) + " · " : ""}${(d.delivery_line_items || []).map((l) => `${fmt(l.quantity)} ${esc(l.materials?.unit || "")} ${esc(l.materials?.name || "")} (${esc(l.locations?.name || "")})`).join(" · ")}</div>` })),
  ].sort((a, b) => new Date(b.t) - new Date(a.t));
  document.getElementById("act").innerHTML = events.length ? `<div class="list">${events.map((e) => `<div class="row"><div>${e.html}<div class="meta">${new Date(e.t).toLocaleString()}</div></div><span class="badge ${e.kind === "in" ? "green" : "grey"}">${e.kind === "in" ? "in" : "out"}</span></div>`).join("")}</div>` : `<div class="box muted">No activity yet.</div>`;
}

async function viewDeliveries() {
  const [trades, locations] = await Promise.all([readTrades(), readLocations()]);
  app.innerHTML = header("#/admin/deliveries") + `<h1>Log delivery</h1><p class="sub">Mirrors your verification workflow — posts straight to inventory.</p>
    <div class="box"><div class="inline">
      <div><label>Trade</label><select id="d-trade">${trades.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("")}</select></div>
      <div><label>Supplier / source</label><input id="d-source" placeholder="Lowe's, Home Depot Pro…" /></div>
    </div><div class="inline" style="margin-top:10px">
      <div><label>PO # (optional)</label><input id="d-po" /></div>
      <div><label>Date</label><input id="d-date" type="date" value="${new Date().toISOString().slice(0, 10)}" /></div>
    </div>
    <h2>Line items</h2><div id="d-lines"></div>
    <button class="sm outline" id="d-addline">+ Add line</button>
    <div class="field" style="margin-top:12px"><label>Notes (optional)</label><input id="d-notes" /></div>
    <div id="d-msg"></div><div class="spacer"></div><button class="block" id="d-submit">Post delivery</button></div>`;
  let mats = [];
  const linesEl = document.getElementById("d-lines");
  const lineRow = () => {
    const div = document.createElement("div"); div.className = "inline"; div.style.marginBottom = "8px";
    div.innerHTML = `<div class="grow2"><select class="d-mat"><option value="">Material…</option>${mats.map((m) => `<option value="${m.id}" data-unit="${esc(m.unit)}">${esc(m.name)}</option>`).join("")}</select></div>
      <div><select class="d-loc">${locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join("")}</select></div>
      <div style="flex:.6"><input class="d-qty" type="number" min="0" step="any" placeholder="Qty" /></div>
      <div style="flex:0"><button class="sm outline d-del">✕</button></div>`;
    div.querySelector(".d-del").onclick = () => div.remove();
    linesEl.appendChild(div);
  };
  const loadMats = async () => { mats = (await sb.from("materials").select("id,name,unit").eq("trade_id", document.getElementById("d-trade").value).order("name")).data || []; linesEl.innerHTML = ""; lineRow(); };
  document.getElementById("d-trade").onchange = loadMats;
  document.getElementById("d-addline").onclick = lineRow;
  await loadMats();
  document.getElementById("d-submit").onclick = async () => {
    const lines = [...linesEl.querySelectorAll(".inline")].map((r) => ({ materialId: r.querySelector(".d-mat").value, locationId: r.querySelector(".d-loc").value, quantity: Number(r.querySelector(".d-qty").value) })).filter((l) => l.materialId && l.quantity > 0);
    const msg = document.getElementById("d-msg");
    if (!lines.length) { msg.innerHTML = `<div class="notice error">Add at least one line with a quantity.</div>`; return; }
    try {
      await apiCall("record_delivery", { tradeId: document.getElementById("d-trade").value, source: document.getElementById("d-source").value, poNumber: document.getElementById("d-po").value, deliveryDate: document.getElementById("d-date").value, notes: document.getElementById("d-notes").value, lines });
      msg.innerHTML = `<div class="notice ok">Delivery posted — inventory updated.</div>`;
      document.getElementById("d-source").value = ""; document.getElementById("d-po").value = ""; linesEl.innerHTML = ""; lineRow();
    } catch (e) { msg.innerHTML = `<div class="notice error">${esc(e.message)}</div>`; }
  };
}

async function viewSettings() {
  const [trades, locations, materials, workers] = await Promise.all([
    readTrades(), readLocations(),
    sb.from("materials").select("id,name,unit,phase,reorder_threshold,trades(name)").order("name").then((r) => r.data || []),
    readWorkers(),
  ]);
  const tOpts = trades.map((t) => `<option value="${t.id}">${esc(t.name)}</option>`).join("");
  app.innerHTML = header("#/admin/settings") + `<h1>Settings</h1><p class="sub">Manage trades, locations, materials, and workers.</p>
    <h2>Trades</h2><div class="list">${trades.map((t) => `<div class="row"><span>${esc(t.name)}</span></div>`).join("")}</div>
    <div class="inline" style="margin-top:8px"><input id="t-name" placeholder="New trade" /><button class="ghost" data-add="add_trade">Add</button></div>

    <h2>Locations</h2><div class="list">${locations.map((l) => `<div class="row"><span>${esc(l.name)}${l.description ? ` <span class="muted">— ${esc(l.description)}</span>` : ""}</span></div>`).join("")}</div>
    <div class="inline" style="margin-top:8px"><input id="l-name" placeholder="Location" /><input id="l-desc" placeholder="Description (optional)" /><button class="ghost" data-add="add_location">Add</button></div>

    <h2>Materials</h2><div class="list">${materials.map((m) => `<div class="row"><span>${esc(m.name)} <span class="muted">· ${esc(m.trades?.name || "")}${m.phase ? " · " + esc(m.phase) : ""} · reorder ${fmt(m.reorder_threshold)} ${esc(m.unit)}</span></span></div>`).join("")}</div>
    <div class="inline" style="margin-top:8px"><select id="m-trade"><option value="">Trade…</option>${tOpts}</select><input id="m-name" placeholder="Material" /><input id="m-unit" placeholder="Unit" value="ea" style="flex:.5" />
    <select id="m-phase" style="flex:.8"><option value="">No phase</option><option>Rough-In</option><option>Trim</option></select><input id="m-reorder" type="number" min="0" placeholder="Reorder" value="0" style="flex:.6" /><button class="ghost" data-add="add_material">Add</button></div>

    <h2>Workers</h2><div class="list">${workers.map((w) => `<div class="row"><div><span class="name" style="${!w.active ? "text-decoration:line-through;color:#94a3b8" : ""}">${esc(w.name)}</span> <span class="muted">· ${w.role === "admin" ? "owner" : "field"}${w.trades?.name ? " · " + esc(w.trades.name) : ""}</span></div>
      <div style="display:flex;gap:4px">${w.active ? `<button class="sm outline" data-rename="${w.id}" data-name="${esc(w.name)}">Rename</button><button class="sm outline" data-pin="${w.id}" data-name="${esc(w.name)}">Set PIN</button><button class="sm outline" data-deact="${w.id}">Deactivate</button>` : ""}</div></div>`).join("")}</div>
    <div class="inline" style="margin-top:8px"><input id="w-name" placeholder="Full name" /><select id="w-trade"><option value="">No trade (owner)</option>${tOpts}</select>
    <select id="w-role" style="flex:.8"><option value="field_worker">Field worker</option><option value="admin">Owner</option></select><input id="w-pin" placeholder="PIN (4-6 digits)" inputmode="numeric" style="flex:.7" /><button class="ghost" data-add="add_worker">Add</button></div>
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
  const adminOnly = path.startsWith("#/admin/");
  if (adminOnly && s.role !== "admin") { location.hash = "#/"; return render(); }
  try {
    if (path === "#/login" || path === "#/") return await viewHome();
    if (path.startsWith("#/trade/")) return await viewTrade(path.split("/")[2]);
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
