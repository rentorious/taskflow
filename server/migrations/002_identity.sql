-- Sign-in: sessions for browsers, tokens for the CLI, invites for people who have not signed in yet.
--
-- Neither a session id nor a token is ever stored. Only their SHA-256 is, so a copy
-- of this database signs nobody in.

create table session (
  id_hash text primary key check (id_hash ~ '^[0-9a-f]{64}$'),
  user_id bigint not null references app_user (id) on delete cascade,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index session_by_user on session (user_id);

create table api_token (
  id bigint generated always as identity primary key,
  user_id bigint not null references app_user (id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  label text not null default '' check (length(label) <= 100),
  created_at timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);
create index api_token_by_user on api_token (user_id);

-- By GitHub login, because that is all an admin knows about a colleague. Consumed at that
-- person's first sign-in. Stored lower-cased: GitHub logins ignore case.
create table invite (
  project_id text not null references project (id) on delete cascade,
  github_login text not null check (github_login = lower(github_login) and github_login ~ '^[a-z0-9][a-z0-9-]{0,38}$'),
  role text not null check (role in ('admin', 'developer', 'answerer')),
  invited_by bigint references app_user (id) on delete set null,
  created_at timestamptz not null default now(),
  primary key (project_id, github_login)
);
