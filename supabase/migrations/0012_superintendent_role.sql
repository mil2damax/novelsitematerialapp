-- Add the superintendent access tier (full site oversight, no settings).
alter table materials.workers drop constraint if exists workers_role_check;
alter table materials.workers add constraint workers_role_check
  check (role in ('admin', 'superintendent', 'foreman', 'field_worker'));
