create table if not exists api_zenoti_booking (
  ref uuid primary key default gen_random_uuid(),
  center_id text not null, center_name text, service_id text not null, service_name text,
  price numeric, duration int, guest_id text, booking_id text,
  first_name text not null, last_name text, phone text not null, email text,
  date text not null, therapist_gender int not null default 0, slot_time text, notes text,
  status text not null default 'started', invoice_id text, appointment_id text, error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now()
);
create index if not exists api_zenoti_booking_phone_idx on api_zenoti_booking (phone, created_at);
create index if not exists api_zenoti_booking_created_idx on api_zenoti_booking (created_at desc);
alter table api_zenoti_booking enable row level security;
