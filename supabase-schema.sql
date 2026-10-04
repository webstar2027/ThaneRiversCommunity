create table if not exists public.users (
 id uuid primary key default gen_random_uuid(), email text unique not null,
 password_hash text not null, name text, is_admin boolean not null default false,
 created_at timestamptz not null default now()
);
create table if not exists public.products (
 id uuid primary key default gen_random_uuid(), name text not null,
 description text default '', category text not null default 'art',
 price numeric(12,2) not null default 0, stock integer not null default 0,
 image_url text, active boolean not null default true,
 created_at timestamptz not null default now()
);
create table if not exists public.orders (
 id uuid primary key default gen_random_uuid(), user_id uuid references public.users(id) on delete set null,
 customer_name text not null, customer_email text not null, phone text,
 shipping_address text not null, shipping_city text, shipping_country text,
 total numeric(12,2) not null default 0,
 status text not null default 'pending' check(status in ('pending','paid','processing','shipped','delivered','cancelled')),
 payment_reference text, created_at timestamptz not null default now()
);
create table if not exists public.order_items (
 id uuid primary key default gen_random_uuid(), order_id uuid not null references public.orders(id) on delete cascade,
 product_id uuid references public.products(id) on delete set null, product_name text not null,
 quantity integer not null default 1, unit_price numeric(12,2) not null default 0
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
 status text not null default 'pending', payment_reference text, created_at timestamptz not null default now()
);
insert into storage.buckets(id,name,public) values('products','products',true) on conflict(id) do nothing;
