// Database connection and schema.
// Uses postgres.js with the DATABASE_URL that Vercel's Neon (Postgres) integration sets.
// The schema below is created automatically the first time the app talks to an empty database.
import postgres from 'postgres';
import { HttpError } from './http.js';

let client = null;

export function db() {
  if (client) return client;
  const url = process.env.DATABASE_URL || process.env.POSTGRES_URL;
  if (!url) throw new HttpError(503, 'The database is not set up yet. See SETUP.md.');
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  client = postgres(url, {
    max: 3,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,                       // works with Neon's and Supabase's connection poolers
    ssl: local ? false : 'require',
    onnotice: () => {},
    types: {
      // NUMERIC comes back as a JS number. Money in this game never needs more than 15 significant digits.
      numeric: { to: 1700, from: [1700], serialize: x => String(x), parse: x => Number(x) },
      bigint: { to: 20, from: [20], serialize: x => String(x), parse: x => Number(x) },
      // DATE stays a 'YYYY-MM-DD' string (market dates in New York), never shifted by time zones.
      date: { to: 1082, from: [1082], serialize: x => x, parse: x => x }
    }
  });
  return client;
}

let ready = null;
export function ensureSchema() {
  if (!ready) {
    ready = db().unsafe(SCHEMA).then(() => true);
    ready.catch(() => { ready = null; });
  }
  return ready;
}

// Get a ready database. Every request goes through here.
export async function sqlReady() {
  await ensureSchema();
  return db();
}

export const SCHEMA = `
create table if not exists schools (
  id serial primary key,
  name text unique not null
);
create table if not exists teachers (
  id serial primary key,
  school_id int not null references schools(id),
  name text not null,
  pw_hash text,
  active boolean not null default true,
  unique (school_id, name)
);
create table if not exists sections (
  id serial primary key,
  teacher_id int not null references teachers(id),
  period text not null,
  unique (teacher_id, period)
);
-- Students are stored by first name and last initial only (no full last names, no emails, no IDs).
alter table sections add column if not exists active boolean not null default true;
alter table teachers add column if not exists pw_enc text;
create table if not exists students (
  id serial primary key,
  section_id int not null references sections(id),
  first text not null,
  last_part text not null,
  display text not null,
  pw_hash text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_login timestamptz,
  unique (section_id, display)
);
alter table students add column if not exists pw_enc text;
alter table students add column if not exists practice boolean not null default false;
create table if not exists accounts (
  student_id int primary key references students(id) on delete cascade,
  cash numeric(18,6) not null default 100000,
  mm_bal numeric(18,6) not null default 0,
  mm_earned numeric(18,6) not null default 0,
  mm_last date,
  spy_start numeric(14,4),
  watch text[] not null default array['SPY','AAPL','MSFT','GOOGL','META','TSLA','V','TLT','ETHE'],
  notes jsonb not null default '[]'::jsonb
);
create table if not exists positions (
  student_id int not null references students(id) on delete cascade,
  sym text not null,
  side text not null check (side in ('long','short')),
  shares numeric(20,6) not null,
  basis numeric(18,6) not null,
  opened_at timestamptz not null default now(),
  drip boolean not null default false,
  income numeric(18,6) not null default 0,
  primary key (student_id, sym, side)
);
create table if not exists trades (
  id bigserial primary key,
  student_id int not null references students(id) on delete cascade,
  sym text not null,
  act text not null check (act in ('buy','sell','short','cover')),
  shares numeric(20,6) not null,
  price numeric(18,6) not null,
  at timestamptz not null default now(),
  d date not null,
  auto boolean not null default false,
  dca_id int,
  basis numeric(18,6),
  pnl numeric(18,6),
  opened_at timestamptz
);
create index if not exists trades_student on trades(student_id, at);
create index if not exists trades_day on trades(d);
create table if not exists dca_plans (
  id serial primary key,
  student_id int not null references students(id) on delete cascade,
  sym text not null,
  amount numeric(14,2) not null,
  freq text not null check (freq in ('week','2week','month')),
  next_date date not null,
  paused boolean not null default false,
  created_at timestamptz not null default now(),
  unique (student_id, sym)
);
create table if not exists income (
  id bigserial primary key,
  student_id int not null references students(id) on delete cascade,
  sym text not null,
  side text not null,
  ex_date date not null,
  pay_date date not null,
  per_share numeric(14,6) not null,
  shares numeric(20,6) not null,
  amount numeric(18,6) not null,
  paid boolean not null default false,
  reinvested numeric(20,6),
  unique (student_id, sym, side, ex_date)
);
create table if not exists snapshots (
  student_id int not null references students(id) on delete cascade,
  d date not null,
  value numeric(18,4) not null,
  primary key (student_id, d)
);
create table if not exists market_days (
  d date primary key,
  spy numeric(14,4),
  done_at timestamptz not null default now()
);
create table if not exists awards (
  d date not null,
  kind text not null,
  student_id int references students(id) on delete cascade,
  value numeric(18,6),
  detail jsonb not null default '{}'::jsonb,
  primary key (d, kind)
);
-- Awards are picked per scope: 'district', 'school:<name>', 'teacher:<id>', 'class:<section id>'.
alter table awards add column if not exists scope text not null default 'district';
do $$ begin
  if not exists (select 1 from information_schema.key_column_usage where table_name = 'awards' and constraint_name = 'awards_pkey' and column_name = 'scope') then
    alter table awards drop constraint if exists awards_pkey;
    alter table awards add primary key (d, kind, scope);
  end if;
end $$;
create table if not exists splits (
  sym text not null,
  exec_date date not null,
  ratio numeric(18,8) not null,
  primary key (sym, exec_date)
);
create table if not exists symbols (
  sym text primary key,
  name text,
  kind text,
  last_px numeric(18,6),
  last_at timestamptz
);
create table if not exists settings (
  k text primary key,
  v jsonb not null
);
create table if not exists login_fail (
  k text not null,
  at timestamptz not null default now()
);
create index if not exists login_fail_k on login_fail(k, at);
`;
