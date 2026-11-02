-- Shipping charges per order by destination (applied on Supabase 2 Nov 2026).
create table if not exists app_shipping_rate (
  id bigserial primary key,
  state varchar(100) not null,           -- 'All India' = default for anywhere not listed
  district varchar(100),                 -- null = whole state
  amount numeric(10,2) not null check (amount >= 0),
  created_at timestamptz not null default now()
);
create unique index if not exists app_shipping_rate_place on app_shipping_rate (lower(trim(state)), lower(trim(coalesce(district, ''))));
alter table app_shipping_rate enable row level security;
create table if not exists app_shop_setting (key varchar(100) primary key, value text not null);
alter table app_shop_setting enable row level security;
insert into app_shop_setting (key, value) values ('free_shipping_above', '1000') on conflict (key) do nothing;
insert into app_shipping_rate (state, district, amount) values
  ('All India', null, 100), ('Kerala', null, 60), ('Kerala', 'Kollam', 40), ('Tamil Nadu', null, 80), ('Karnataka', null, 80)
on conflict do nothing;
