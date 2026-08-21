-- Staging area for spreadsheet-driven deliveries. Claude parses the tracker and
-- stages RECEIVED items here as a pending batch; an owner reviews and publishes,
-- which is the moment inventory actually moves. Served only through the `imports`
-- edge function (service role); no anon access.

create table if not exists materials.import_batches (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  trade_id uuid references materials.trades (id),
  source text,
  status text not null default 'pending' check (status in ('pending', 'published', 'discarded')),
  created_by uuid references materials.workers (id),
  created_at timestamptz not null default now(),
  published_at timestamptz
);

create table if not exists materials.import_lines (
  id uuid primary key default gen_random_uuid(),
  batch_id uuid not null references materials.import_batches (id) on delete cascade,
  item_name text not null,
  unit text not null default 'ea',
  quantity numeric not null,
  order_ref text,
  cost numeric,
  date_received text,
  notes text,
  include boolean not null default true,
  created_at timestamptz not null default now()
);
create index if not exists idx_import_lines_batch on materials.import_lines (batch_id);

alter table materials.import_batches enable row level security;
alter table materials.import_lines enable row level security;

grant all on materials.import_batches to service_role;
grant all on materials.import_lines to service_role;

-- Publish a batch: create the materials that don't exist yet, move the included
-- lines' received quantities into inventory at the chosen location, and log one
-- delivery for the activity trail. Only runs while the batch is pending.
create or replace function materials.publish_import_batch(p_batch_id uuid, p_location_id uuid)
returns integer
language plpgsql
set search_path = ''
as $$
declare
  v_batch materials.import_batches;
  v_line materials.import_lines;
  v_material_id uuid;
  v_delivery_id uuid;
  v_trade_id uuid;
  v_count integer := 0;
begin
  select * into v_batch from materials.import_batches where id = p_batch_id;
  if not found or v_batch.status <> 'pending' then
    raise exception 'batch not pending';
  end if;
  v_trade_id := coalesce(v_batch.trade_id, (select id from materials.trades where name = 'Electrical'));

  insert into materials.deliveries (trade_id, source, delivery_date, verified_by, notes)
  values (v_trade_id, coalesce(v_batch.source, v_batch.label), current_date, v_batch.created_by,
          'Published from tracker import: ' || v_batch.label)
  returning id into v_delivery_id;

  for v_line in select * from materials.import_lines where batch_id = p_batch_id and include = true loop
    select id into v_material_id from materials.materials
      where trade_id = v_trade_id and lower(name) = lower(v_line.item_name) limit 1;

    if v_material_id is null then
      insert into materials.materials (trade_id, name, unit)
      values (v_trade_id, v_line.item_name, v_line.unit)
      on conflict (trade_id, name) do update set unit = excluded.unit
      returning id into v_material_id;
    end if;

    insert into materials.delivery_line_items (delivery_id, material_id, location_id, quantity)
    values (v_delivery_id, v_material_id, p_location_id, v_line.quantity);

    insert into materials.inventory_items (material_id, location_id, quantity_on_hand, updated_at)
    values (v_material_id, p_location_id, v_line.quantity, now())
    on conflict (material_id, location_id)
    do update set quantity_on_hand = materials.inventory_items.quantity_on_hand + excluded.quantity_on_hand, updated_at = now();

    v_count := v_count + 1;
  end loop;

  update materials.import_batches set status = 'published', published_at = now() where id = p_batch_id;
  return v_count;
end;
$$;
