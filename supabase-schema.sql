create extension if not exists pgcrypto;
create table if not exists public.users (
 id uuid primary key default gen_random_uuid(), email text unique not null,
 password_hash text not null, name text, is_admin boolean not null default false,
 created_at timestamptz not null default now()
);
create table if not exists public.messages (
 id uuid primary key default gen_random_uuid(), user_id uuid references public.users(id) on delete cascade,
 sender_role text not null check(sender_role in ('customer','admin')), body text not null,
 created_at timestamptz not null default now()
);
create table if not exists public.support_payments (
 id uuid primary key default gen_random_uuid(), user_id uuid references public.users(id) on delete set null,
 customer_email text, amount numeric(12,2) not null,
 type text not null check(type in ('donation','subscription')),
 status text not null default 'pending', payment_reference text, expires_at timestamptz, created_at timestamptz not null default now()
);
create index if not exists messages_user_id_idx on public.messages(user_id,created_at);
create index if not exists support_payments_user_type_idx on public.support_payments(user_id,type,status);
