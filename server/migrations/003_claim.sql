-- A batch is claimed here, not by a directory on one laptop: the partial unique
-- index is the compare-and-swap, and it holds across machines.

create table claim (
  id bigint generated always as identity primary key,
  project_id text not null references project (id) on delete cascade,
  cycle_id uuid not null references cycle (id) on delete cascade,
  batch_key text not null,
  user_id bigint not null references app_user (id) on delete cascade,
  host text,
  claimed_at timestamptz not null default now(),
  released_at timestamptz
);
create unique index claim_one_open on claim (cycle_id, batch_key) where released_at is null;
