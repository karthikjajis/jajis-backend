# Jaji's backend (Supabase)

Backend for www.jajisinnovation.com. It replaced the old Django backend that ran on Railway.

| Part | Where it runs |
|---|---|
| API (`supabase/functions/api`) | Supabase Edge Function `api` in project **JAJIS WEBSITE** (`tbkvtcuqszgmahzswspe`) |
| Database | Supabase Postgres (same tables as the old Django app) |
| Admin panel (`admin/`) | Vercel project `jajis-admin` → https://jajis-admin.vercel.app |
| Images | Cloudinary |
| Payments / email | Razorpay / Brevo |

API base URL: `https://tbkvtcuqszgmahzswspe.supabase.co/functions/v1/api/`

## Deploying the API

```bash
npm i -g supabase
supabase login
supabase link --project-ref tbkvtcuqszgmahzswspe
supabase functions deploy api --no-verify-jwt
```

`--no-verify-jwt` is required: the website and admin send their own `Authorization: Token …` header.

## Secrets (set in Supabase → Edge Functions → Secrets, never in this repo)

`RAZORPAY_KEY_ID`, `RAZORPAY_KEY_SECRET`, `RAZORPAY_WEBHOOK_SECRET` (optional), `BREVO_API_KEY`,
`DEFAULT_FROM_EMAIL`, `ADMIN_NOTIFY_EMAIL`, `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`,
`CLOUDINARY_API_SECRET`, `CORS_ALLOWED_ORIGINS` (optional). `SUPABASE_DB_URL` is provided by Supabase.

## Files

- `index.ts` – router and public routes (pages, forms, accounts, shop, payments, orders)
- `shop.ts` – cart, wishlist, orders, Razorpay
- `admin.ts` – staff-only admin API
- `email.ts` – email templates (Brevo)
- `util.ts`, `db.ts`, `validate.ts` – helpers, CORS, token auth, Django-compatible password hashing
- `supabase/migrations/` – extra table for OTP brute-force protection

## WhatsApp order alerts (Meta WhatsApp Cloud API)
Off until these Supabase secrets exist: `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ADMIN_NUMBERS` (comma-separated).
Optional: `WHATSAPP_ORDER_TEMPLATE` (order_confirmation), `WHATSAPP_ADMIN_TEMPLATE` (new_order_alert), `WHATSAPP_SHIPPED_TEMPLATE` (order_shipped), `WHATSAPP_TEMPLATE_LANG` (en).
Sent when an order becomes paid (customer + staff) and when staff mark it shipped. Test from Admin → Email & WhatsApp.

Deploy note: the live `api` function is a one-line entry that imports `supabase/functions/api/index.ts` from a pinned commit on GitHub; to ship a change, push and redeploy with the new commit hash.
