-- Richer material requests: photo, Lowe's link + SKU, why, and takeoff-shortfall.
alter table materials.material_requests add column if not exists lowes_link text;
alter table materials.material_requests add column if not exists sku text;
alter table materials.material_requests add column if not exists why text;
alter table materials.material_requests add column if not exists takeoff_short boolean not null default false;
alter table materials.material_requests add column if not exists takeoff_explain text;
alter table materials.material_requests add column if not exists photo_url text;

-- Public bucket for request photos. Uploads happen through the requests edge
-- function (service role); the public flag makes stored images viewable by URL
-- on the admin worklist. No anon write path.
insert into storage.buckets (id, name, public)
values ('request-photos', 'request-photos', true)
on conflict (id) do nothing;
