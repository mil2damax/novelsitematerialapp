// Single authed router for every privileged operation. The browser POSTs
// { action, ...args } with the session token in x-session-token. We verify the
// token, enforce admin-only actions, and run the operation via the service role
// (reusing the transactional DB functions built for the app).
import bcrypt from "https://esm.sh/bcryptjs@2.4.3";
import { cors, json, service, verifyToken, sessionHeader } from "./_shared.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const session = await verifyToken(sessionHeader(req));
  if (!session) return json({ error: "unauthorized" }, 401);
  const isAdmin = session.role === "admin";

  let p: any;
  try {
    p = await req.json();
  } catch {
    return json({ error: "bad json" }, 400);
  }
  const db = service();
  const forbid = () => json({ error: "forbidden" }, 403);

  try {
    switch (p.action) {
      case "clock_out": {
        const lines = Array.isArray(p.lines) ? p.lines : [];
        if (!lines.length) return json({ error: "No items." }, 400);
        // A field worker can only clock out against their own trade.
        if (!isAdmin && session.tradeId && p.tradeId !== session.tradeId) return forbid();
        const { data, error } = await db.rpc("clock_out_materials", {
          p_worker_id: session.sub,
          p_trade_id: p.tradeId,
          p_notes: p.notes || null,
          p_lines: lines.map((l: any) => ({ material_id: l.materialId, location_id: l.locationId, quantity: l.quantity })),
          p_client_uuid: p.clientUuid || null,
        });
        if (error) {
          if (String(error.message).includes("INSUFFICIENT_STOCK")) return json({ error: "insufficient_stock" }, 409);
          return json({ error: error.message }, 400);
        }
        return json({ ok: true, clockoutId: data });
      }

      case "create_request": {
        if (!p.materialName || !(p.quantity > 0)) return json({ error: "Pick a material and quantity." }, 400);
        const { data, error } = await db.rpc("create_material_request", {
          p_worker_id: session.sub,
          p_trade_id: p.tradeId || null,
          p_material_id: p.materialId || null,
          p_material_name: p.materialName,
          p_location_id: p.locationId || null,
          p_quantity: p.quantity,
          p_notes: p.notes || null,
        });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, requestId: data });
      }

      case "list_activity": {
        if (!isAdmin) return forbid();
        const { data: clockouts } = await db
          .from("clockouts")
          .select("id, notes, created_at, workers(name), trades(name), clockout_line_items(quantity, materials(name, unit), locations(name))")
          .order("created_at", { ascending: false })
          .limit(100);
        const { data: deliveries } = await db
          .from("deliveries")
          .select("id, source, po_number, delivery_date, notes, created_at, trades(name), workers(name), delivery_line_items(quantity, materials(name, unit), locations(name))")
          .order("created_at", { ascending: false })
          .limit(100);
        return json({ clockouts: clockouts || [], deliveries: deliveries || [] });
      }

      case "list_requests": {
        if (!isAdmin) return forbid();
        const status = p.status || "open";
        let q = db
          .from("material_requests")
          .select("id, material_name, quantity, notes, status, created_at, workers(name), trades(name), locations(name)")
          .order("created_at", { ascending: false });
        if (status !== "all") q = q.eq("status", status);
        const { data } = await q;
        return json({ requests: data || [] });
      }

      case "set_request_status": {
        if (!isAdmin) return forbid();
        const allowed = ["open", "ordered", "fulfilled", "cancelled"];
        if (!p.id || !allowed.includes(p.status)) return json({ error: "bad" }, 400);
        const resolved = p.status === "fulfilled" || p.status === "cancelled";
        const { error } = await db
          .from("material_requests")
          .update({ status: p.status, resolved_at: resolved ? new Date().toISOString() : null, resolved_by: resolved ? session.sub : null })
          .eq("id", p.id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case "record_delivery": {
        if (!isAdmin) return forbid();
        const lines = Array.isArray(p.lines) ? p.lines : [];
        if (!p.source || !lines.length) return json({ error: "Need a source and at least one line." }, 400);
        const { data, error } = await db.rpc("record_delivery", {
          p_trade_id: p.tradeId,
          p_source: p.source,
          p_po_number: p.poNumber || null,
          p_delivery_date: p.deliveryDate,
          p_verified_by: session.sub,
          p_notes: p.notes || null,
          p_lines: lines.map((l: any) => ({ material_id: l.materialId, location_id: l.locationId, quantity: l.quantity })),
        });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, deliveryId: data });
      }

      case "add_trade": {
        if (!isAdmin) return forbid();
        const name = String(p.name || "").trim();
        if (!name) return json({ error: "name" }, 400);
        const { error } = await db.from("trades").insert({ name });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case "add_location": {
        if (!isAdmin) return forbid();
        const name = String(p.name || "").trim();
        if (!name) return json({ error: "name" }, 400);
        const { error } = await db.from("locations").insert({ name, description: String(p.description || "").trim() || null });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case "add_material": {
        if (!isAdmin) return forbid();
        const name = String(p.name || "").trim();
        if (!p.tradeId || !name) return json({ error: "bad" }, 400);
        const { data: mat, error } = await db
          .from("materials")
          .insert({ trade_id: p.tradeId, name, unit: String(p.unit || "ea").trim() || "ea", reorder_threshold: Number(p.reorderThreshold) || 0, phase: p.phase || null })
          .select("id")
          .single();
        if (error) return json({ error: error.message }, 400);
        // Seed a zero-stock row at the first location so it shows up immediately.
        const { data: loc } = await db.from("locations").select("id").order("name").limit(1).single();
        if (mat && loc) await db.from("inventory_items").insert({ material_id: mat.id, location_id: loc.id, quantity_on_hand: 0 });
        return json({ ok: true });
      }

      case "add_worker": {
        if (!isAdmin) return forbid();
        const name = String(p.name || "").trim();
        if (!name || !/^\d{4,6}$/.test(String(p.pin || ""))) return json({ error: "Name and a 4-6 digit PIN required." }, 400);
        const role = p.role === "admin" ? "admin" : "field_worker";
        const pin_hash = bcrypt.hashSync(String(p.pin), 10);
        const { error } = await db.from("workers").insert({ name, trade_id: p.tradeId || null, role, pin_hash });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case "deactivate_worker": {
        if (!isAdmin) return forbid();
        if (!p.id) return json({ error: "id" }, 400);
        const { error } = await db.from("workers").update({ active: false }).eq("id", p.id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case "rename_worker": {
        if (!isAdmin) return forbid();
        const name = String(p.name || "").trim();
        if (!p.id || !name) return json({ error: "bad" }, 400);
        const { error } = await db.from("workers").update({ name }).eq("id", p.id);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case "set_pin": {
        // Any worker may change their own PIN; an admin may change anyone's.
        const targetId = p.id && isAdmin ? p.id : session.sub;
        if (!/^\d{4,6}$/.test(String(p.pin || ""))) return json({ error: "PIN must be 4-6 digits." }, 400);
        const pin_hash = bcrypt.hashSync(String(p.pin), 10);
        const { error } = await db.from("workers").update({ pin_hash }).eq("id", targetId);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      default:
        return json({ error: "unknown action" }, 400);
    }
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
