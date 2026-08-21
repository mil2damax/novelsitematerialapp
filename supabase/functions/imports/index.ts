// Import-staging router: stage spreadsheet-parsed deliveries, review, publish to
// inventory. Owner-only. Same token model as the api function.
import { cors, json, service, verifyToken, sessionHeader } from "./_shared.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const session = await verifyToken(sessionHeader(req));
  if (!session || session.role !== "admin") return json({ error: "forbidden" }, 403);

  let p: any;
  try { p = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const db = service();

  try {
    switch (p.action) {
      case "stage_import": {
        const lines = Array.isArray(p.lines) ? p.lines : [];
        if (!lines.length) return json({ error: "No lines to stage." }, 400);
        const { data: batch, error } = await db
          .from("import_batches")
          .insert({ label: p.label || "Import", trade_id: p.tradeId || null, source: p.source || null, created_by: session.sub })
          .select("id").single();
        if (error) return json({ error: error.message }, 400);
        const rows = lines.map((l: any) => ({
          batch_id: batch.id, item_name: l.item_name, unit: l.unit || "ea", quantity: Number(l.quantity) || 0,
          order_ref: l.order_ref || null, cost: l.cost != null ? Number(l.cost) : null,
          date_received: l.date_received || null, notes: l.notes || null,
        }));
        const { error: e2 } = await db.from("import_lines").insert(rows);
        if (e2) return json({ error: e2.message }, 400);
        return json({ ok: true, batchId: batch.id, count: rows.length });
      }

      case "list_imports": {
        const { data } = await db
          .from("import_batches")
          .select("id,label,source,status,created_at,published_at,trades(name),import_lines(count)")
          .order("created_at", { ascending: false }).limit(50);
        return json({ batches: data || [] });
      }

      case "get_import": {
        const { data: batch } = await db.from("import_batches").select("id,label,source,status,created_at,trade_id,trades(name)").eq("id", p.id).single();
        const { data: lines } = await db.from("import_lines").select("*").eq("batch_id", p.id).order("created_at");
        return json({ batch, lines: lines || [] });
      }

      case "set_import_line": {
        const patch: any = {};
        if (p.include != null) patch.include = !!p.include;
        if (p.quantity != null) patch.quantity = Number(p.quantity);
        if (p.unit != null) patch.unit = String(p.unit);
        if (!p.lineId || !Object.keys(patch).length) return json({ error: "bad" }, 400);
        const { error } = await db.from("import_lines").update(patch).eq("id", p.lineId);
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true });
      }

      case "publish_import": {
        if (!p.id || !p.locationId) return json({ error: "Pick a location to store these at." }, 400);
        const { data, error } = await db.rpc("publish_import_batch", { p_batch_id: p.id, p_location_id: p.locationId });
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, published: data });
      }

      case "discard_import": {
        const { error } = await db.from("import_batches").update({ status: "discarded" }).eq("id", p.id);
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
