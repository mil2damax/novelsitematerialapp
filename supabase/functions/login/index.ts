// POST { workerId, pin } -> verifies the PIN against the bcrypt hash (using the
// service role, so pin_hash never leaves the server) and returns a signed
// session token the app sends back on every privileged call.
import bcrypt from "https://esm.sh/bcryptjs@2.4.3";
import { cors, json, service, signToken, type Session } from "./_shared.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);

  try {
    const { workerId, pin } = await req.json();
    if (!workerId || !pin) return json({ error: "Pick your name and enter your PIN." }, 400);

    const db = service();
    const { data: worker, error } = await db
      .from("workers")
      .select("id, name, role, trade_id, pin_hash, active")
      .eq("id", workerId)
      .single();

    if (error || !worker || !worker.active) return json({ error: "invalid" }, 401);
    if (!bcrypt.compareSync(String(pin), worker.pin_hash)) return json({ error: "invalid" }, 401);

    const session: Session = {
      sub: worker.id,
      name: worker.name,
      role: worker.role === "admin" ? "admin" : "field_worker",
      tradeId: worker.trade_id,
      exp: Date.now() + 12 * 60 * 60 * 1000, // 12-hour shift session
    };
    const token = await signToken(session);
    return json({ token, worker: { id: worker.id, name: worker.name, role: session.role, tradeId: worker.trade_id }, exp: session.exp });
  } catch (e) {
    return json({ error: String(e) }, 500);
  }
});
