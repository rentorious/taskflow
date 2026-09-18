-- Identity, pushed cycles, and what people record on them.
--
-- No schema is named anywhere: tests run every migration inside a throwaway
-- schema. Vocabularies are text + CHECK rather than enum types, and nothing
-- needs an extension.
--
-- One writer per datum. A laptop owns `cycle` and `blob` (pipeline state, pushed).
-- People own `question_state`, `answer` and `inbox_tick`, through the dashboard.

create table app_user (
  id bigint generated always as identity primary key,
  github_id bigint unique,                       -- null until the first GitHub sign-in binds it
  login text not null check (login ~ '^[A-Za-z0-9][A-Za-z0-9-]{0,38}$'),
  name text,
  avatar_url text,
  is_instance_admin boolean not null default false,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz
);
create unique index app_user_login_key on app_user (lower(login));  -- GitHub logins ignore case

create table project (
  id text primary key check (id ~ '^[a-z0-9][a-z0-9-]{1,38}$'),   -- the key in URLs and in the project config
  name text not null check (length(name) between 1 and 200),
  created_by bigint references app_user (id) on delete set null,
  created_at timestamptz not null default now(),
  -- Bumped by every write a person makes. The UPDATE doubles as a per-project
  -- mutex, which is what makes "has anyone answered since I looked" race-free.
  human_rev bigint not null default 0
);

create table membership (
  project_id text not null references project (id) on delete cascade,
  user_id bigint not null references app_user (id) on delete cascade,
  role text not null check (role in ('admin', 'developer', 'answerer')),
  created_at timestamptz not null default now(),
  primary key (project_id, user_id)
);

-- One row per triage cycle of one developer. The id is minted on the laptop
-- (cycle.<slug>.json), so the owner columns are part of every lookup: an id
-- alone must never be enough to reach a row.
create table cycle (
  id uuid primary key,
  project_id text not null references project (id) on delete cascade,
  user_id bigint not null references app_user (id) on delete cascade,
  is_live boolean not null,
  archived_as text check (archived_as ~ '^[A-Za-z0-9][A-Za-z0-9._-]*$'),
  last_triage text,
  dev_head text,
  -- json, not jsonb: jsonb reorders object keys, and the view model iterates them in the order triage wrote.
  snapshot json not null,
  payload_sha256 text not null,                  -- canonical hash: "did this push change anything"
  rev bigint not null default 1,                 -- bumped when it did, and when a missing blob arrives
  pushed_at timestamptz not null default now(),
  pushed_from text,
  created_at timestamptz not null default now(),
  check (is_live = (archived_as is null))
);
create unique index cycle_one_live on cycle (project_id, user_id) where is_live;
create unique index cycle_archive_name on cycle (project_id, user_id, archived_as) where not is_live;

-- Plan text, cycle notes and attachments, by content hash. Keyed per project:
-- with a shared store, naming another project's hash in a manifest would read its file.
create table blob (
  project_id text not null references project (id) on delete cascade,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  size integer not null check (size between 0 and 10485760),
  body bytea not null,
  created_at timestamptz not null default now(),
  primary key (project_id, sha256),
  check (octet_length(body) = size)
);

-- What a cycle's manifest refers to. Names, sizes and times stay in the snapshot.
-- Deliberately no foreign key to blob: a push records the manifest first and uploads after.
create table cycle_blob (
  cycle_id uuid not null references cycle (id) on delete cascade,
  project_id text not null references project (id) on delete cascade,
  sha256 text not null check (sha256 ~ '^[0-9a-f]{64}$'),
  primary key (cycle_id, sha256)
);
create index cycle_blob_by_hash on cycle_blob (project_id, sha256);

-- Keyed by task, not by cycle: an answer follows its task through a clean and a re-triage.
create table question_state (
  project_id text not null references project (id) on delete cascade,
  task_id text not null,
  key text not null,
  resolution text check (resolution in ('sent', 'dropped', 'answered')),
  fingerprint text,                              -- of the wording this state was recorded on
  question_title text not null default '',
  question_text text not null default '',
  note text not null default '',
  updated_at timestamptz not null default now(),
  updated_by bigint references app_user (id) on delete set null,
  primary key (project_id, task_id, key)
);

-- Append-only. The newest accepted row wins, by id: imported rows keep their original dates.
create table answer (
  id bigint generated always as identity primary key,
  public_id text not null,                       -- what the page sees and sends back as previousAnswerId
  project_id text not null references project (id) on delete cascade,
  task_id text not null,
  key text not null,
  body text not null,
  source text not null default '',
  question_fingerprint text,                     -- what was actually asked, word for word
  question_title text not null default '',
  question_text text not null default '',
  idempotency_key text,
  via text not null default 'web' check (via in ('web', 'mcp')),
  -- An answerer's answer is a proposal until a developer accepts it. Only accepted rows
  -- are ever loaded, and only accepting one may mark its question answered.
  accepted_by bigint references app_user (id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  created_by bigint references app_user (id) on delete set null,
  unique (project_id, task_id, key, public_id),
  unique (project_id, task_id, key, idempotency_key)
);
create index answer_by_question on answer (project_id, task_id, key, id);

-- Every other kind of tick. These describe one cycle and are archived with it.
create table inbox_tick (
  project_id text not null references project (id) on delete cascade,
  cycle_id uuid not null references cycle (id) on delete cascade,
  item_id text not null,
  resolution text not null,
  fingerprint text,
  title text not null default '',
  note text not null default '',
  updated_at timestamptz not null default now(),
  updated_by bigint references app_user (id) on delete set null,
  primary key (cycle_id, item_id)
);

-- No foreign keys: the log outlives what it describes.
create table audit_log (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  user_id bigint,
  project_id text,
  action text not null,
  payload json not null default '{}'
);
create index audit_log_by_project on audit_log (project_id, at);
