-- Sub-category within a phase (e.g. Rough-In → "Wire" vs "Boxes & Fittings",
-- Trim → "Receptacles & Plates"). Optional; groups the trade + inventory views.
alter table materials.materials add column if not exists category text;
