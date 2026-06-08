create table if not exists public.users (
  id text primary key,
  type text not null,
  phone text unique,
  name text not null default 'Expression Trainee',
  created_at bigint not null,
  last_login_at bigint not null
);

create table if not exists public.user_sync (
  user_id text primary key references public.users(id) on delete cascade,
  data jsonb not null default '{"checkins":[],"records":[],"favorites":[],"contents":[]}'::jsonb,
  updated_at bigint not null
);

create table if not exists public.media_files (
  id text primary key,
  user_id text not null references public.users(id) on delete cascade,
  kind text not null,
  storage_path text not null,
  mime_type text not null,
  created_at bigint not null
);

create index if not exists media_files_user_id_idx on public.media_files(user_id);
