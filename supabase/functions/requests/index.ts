// Material requests: create (with optional photo), list (admin), set status (admin).
// The request record IS the order worklist — no email.
import { cors, json, service, verifyToken, sessionHeader } from "./_shared.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  const session = await verifyToken(sessionHeader(req));
  if (!session) return json({ error: "unauthorized" }, 401);
  const isAdmin = session.role === "admin";

  let p: any;
  try { p = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  const db = service();

  try {
    switch (p.action) {
      case "create_request": {
        const title = String(p.title || "").trim();
        if (!title) return json({ error: "Say what's needed." }, 400);
        if (!(Number(p.quantity) > 0)) return json({ error: "Enter how many." }, 400);
        if (!String(p.why || "").trim()) return json({ error: "Say why it's needed." }, 400);
        if (p.takeoffShort && !String(p.takeoffExplain || "").trim()) return json({ error: "Explain the takeoff shortfall." }, 400);

        let photo_url: string | null = null;
        if (p.photoBase64) {
          try {
            const bytes = Uint8Array.from(atob(p.photoBase64), (c) => c.charCodeAt(0));
            const path = crypto.randomUUID() + ".jpg";
            const { error: upErr } = await db.storage.from("request-photos").upload(path, bytes, { contentType: p.photoMime || "image/jpeg", upsert: false });
            if (!upErr) photo_url = db.storage.from("request-photos").getPublicUrl(path).data.publicUrl;
          } catch { /* photo is best-effort; don't fail the request over it */ }
        }

        const { data, error } = await db.from("material_requests").insert({
          worker_id: session.sub,
          trade_id: p.tradeId || session.tradeId || null,
          material_id: p.materialId || null,
          material_name: title,
          location_id: p.locationId || null,
          quantity: Number(p.quantity),
          why: String(p.why).trim(),
          lowes_link: String(p.lowesLink || "").trim() || null,
          sku: String(p.sku || "").trim() || null,
          takeoff_short: !!p.takeoffShort,
          takeoff_explain: p.takeoffShort ? String(p.takeoffExplain).trim() : null,
          photo_url,
        }).select("id").single();
        if (error) return json({ error: error.message }, 400);
        return json({ ok: true, requestId: data.id, photo: !!photo_url });
      }

      case "list_requests": {
        if (!isAdmin) return json({ error: "forbidden" }, 403);
        let q = db.from("material_requests")
          .select("id, material_name, quantity, why, lowes_link, sku, takeoff_short, takeoff_explain, photo_url, status, created_at, workers!worker_id(name), trades(name)")
          .order("created_at", { ascending: false });
        if (p.status && p.status !== "all") q = q.eq("status", p.status);
        if (p.takeoffOnly) q = q.eq("takeoff_short", true);
        const { data } = await q;
        return json({ requests: data || [] });
      }

      case "set_request_status": {
        if (!isAdmin) return json({ error: "forbidden" }, 403);
        const allowed = ["open", "ordered", "fulfilled", "cancelled"];
        if (!p.id || !allowed.includes(p.status)) return json({ error: "bad" }, 400);
        const resolved = p.status === "fulfilled" || p.status === "cancelled";
        const { error } = await db.from("material_requests")
          .update({ status: p.status, resolved_at: resolved ? new Date().toISOString() : null, resolved_by: resolved ? session.sub : null })
          .eq("id", p.id);
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
