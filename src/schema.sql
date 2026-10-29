create table if not exists tokens (
  id integer primary key,
  token_number text not null unique,
  pin_hash text not null,
  balance_ugx integer not null default 0 check (balance_ugx >= 0),
  status text not null default 'active' check (status in ('active', 'locked', 'disabled')),
  failed_pin_attempts integer not null default 0,
  locked_until text,
  created_at text not null
);

create table if not exists ledger (
  id integer primary key,
  token_id integer not null references tokens(id),
  type text not null check (type in ('top_up', 'debit')),
  amount_ugx integer not null check (amount_ugx > 0),
  reference text not null,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
create unique index if not exists ledger_type_reference on ledger(type, reference);

create table if not exists sessions (
  id text primary key,
  token_id integer not null references tokens(id),
  title_id text not null,
  price_ugx integer not null check (price_ugx > 0),
  destination text not null check (destination in ('usb', 'phone')),
  expected_size integer not null check (expected_size > 0),
  chunk_size integer not null check (chunk_size > 0),
  chunk_hashes text not null,
  file_checksum text not null,
  bytes_confirmed integer not null default 0 check (bytes_confirmed >= 0),
  paid integer not null default 0 check (paid in (0, 1)),
  status text not null default 'active' check (status in ('active', 'complete', 'abandoned')),
  last_activity_at text not null,
  created_at text not null
);
create unique index if not exists one_active_session_per_token on sessions(token_id) where status = 'active';

create table if not exists audit_log (
  id integer primary key,
  actor text not null,
  action text not null,
  subject text,
  detail text,
  created_at text not null default (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
