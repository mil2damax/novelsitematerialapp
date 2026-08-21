# Site Materials — Novel Construction

Static web app for tracking construction-site materials by trade. Plain HTML/CSS/JS
that talks to Supabase — no build step, no server to run. Hosted on GitHub Pages at
**sm.novelconstruction.co**.

## How it's put together

- **Front-end:** `index.html`, `styles.css`, `app.js` (a small single-page app). These
  are the only files GitHub Pages serves.
- **Reads** (trade buttons, materials, stock, worker names) come straight from Supabase
  with the public anon key, guarded by Row Level Security.
- **Anything privileged** (login/PIN check, clock-out, deliveries, activity, admin edits)
  goes through two Supabase **edge functions** — `login` and `api` — which hold the
  secret `service_role` key. That key is never in this repo or the browser.
- **Login** returns a signed session token stored in the browser; a field worker's token
  carries their trade, so they only ever see their own trade. Owners see everything.
- **Offline:** clock-outs made with no signal are queued in the browser (IndexedDB) and
  sync automatically when back online.

The Supabase backend (schema, functions, RLS, edge functions) is already deployed to the
project `site-material-app` (ref `qticvdfcanuptafxruex`). The SQL and edge-function source
are kept under `supabase/` for reference — you don't need to redeploy them to host the site.

## Config

The Supabase URL and **anon** key are in `app.js` at the top. Both are safe to be public
(the anon key is designed to be — RLS and the edge functions do the protecting). There are
**no secrets in this repo**, so the GitHub repo can be public.

## Deploy to GitHub Pages

1. Create a repo on GitHub (public is fine — no secrets here) and push these files to the
   `main` branch. From this folder:
   ```
   git init -b main
   git add -A
   git commit -m "Site Materials static app"
   git remote add origin https://github.com/YOUR-USERNAME/site-materials.git
   git push -u origin main
   ```
2. On GitHub: **Settings → Pages →** Source = "Deploy from a branch", Branch = `main`, folder
   = `/ (root)`. Save.
3. The `CNAME` file already sets the custom domain to `sm.novelconstruction.co`. In your DNS
   for `novelconstruction.co`, add a record:
   - **Type:** CNAME · **Name/Host:** `sm` · **Value:** `YOUR-USERNAME.github.io`
4. Back in **Settings → Pages**, tick **Enforce HTTPS** once it's available (a few minutes).

Every `git push` after that updates the live site.

## First-run

Two owner logins are seeded — **Milan** and **Co-Owner**, both PIN **0000**. Log in, then
in **Settings** change both PINs and rename "Co-Owner". Add field workers there too — each
one gets a trade, and only sees that trade.
