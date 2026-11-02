// Jaji's Innovation website API — Supabase Edge Function replacement for the Django backend.
// Same URLs (/api/...), same JSON responses, same token login, same Razorpay + Brevo behaviour.
import { sql, iso, money, paise } from "./db.ts";
import {
  authenticate, background, bad, checkPassword, corsHeaders, EMAIL_RE, HttpError, img, json, makePassword, newTokenKey,
  notFound, randomDigits, readBody, requireUser, todayIST, toInt, type User,
} from "./util.ts";
import { validate } from "./validate.ts";
import { sendEventHallEmails, sendFranchiseEmails, sendPasswordResetOtpEmail } from "./email.ts";
import {
  addressJson, cartJson, notifyOrder, markOrderPaid, ordersJson, productJson, razorpayKeyId, rzp, syncOrderWithRazorpay,
  shippingFor, shippingRules, variantJson, variantsByProduct, verifyPaymentSignature, verifyWebhookSignature, wishlistId, wishlistJson,
} from "./shop.ts";
import { adminRoutes } from "./admin.ts";

type Ctx = { req: Request; user: User | null; params: Record<string, string>; body: () => Promise<Record<string, any>> };
type Handler = (c: Ctx) => Promise<Response> | Response;
type Route = { pattern: RegExp; keys: string[]; methods: Record<string, Handler>; noAuth?: boolean };

const routes: Route[] = [];
export function route(path: string, methods: Record<string, Handler>, opts: { noAuth?: boolean } = {}) {
  const keys: string[] = [];
  const re = path.replace(/\/$/, "").replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)"));
  routes.push({ pattern: new RegExp(`^${re}/?$`), keys, methods, noAuth: opts.noAuth });
}

// =============================================================== public pages
route("/", { GET: async () => {
  const [b] = await sql`select * from app_bannerimage order by uploaded_at desc nulls last limit 1`;
  return json({
    page: "Home", content: "This is the Home page.",
    video: b ? { id: b.id, image: img(b.image), uploaded_at: iso(b.uploaded_at) } : null,
  });
} });

const salonJson = (s: any) => ({
  id: s.id, image: img(s.image), image1: img(s.image1), image2: img(s.image2), image3: img(s.image3),
  image4: img(s.image4), image5: img(s.image5), image6: img(s.image6),
  name: s.name, description: s.description, google_map_url: s.google_map_url, location: s.location,
});
route("/salons", { GET: async () => json({ page: "Salons page", data: (await sql`select * from app_saloon order by id`).map(salonJson) }) });
route("/salons/:id", { GET: async ({ params }) => {
  if (!/^\d+$/.test(params.id)) throw notFound();
  const [s] = await sql`select * from app_saloon where id = ${Number(params.id)}`;
  if (!s) throw notFound("No Saloon matches the given query.");
  return json({ page: "Salon Detail", data: salonJson(s) });
} });

route("/food-court", { GET: async () => json({
  page: "Food Menu",
  data: (await sql`select * from app_foodmenu order by id`).map((f) => ({ id: f.id, title: f.title, description: f.description, image: img(f.image), price: f.price })),
}) });
route("/academy", { GET: async () => json({
  page: "course",
  data: (await sql`select * from app_courses order by id`).map((c) => ({ id: c.id, image: img(c.image), course: c.course, duration: c.duration, description: c.description })),
}) });
const staticPage = (page: string, content: string) => ({ GET: () => json({ page, content }) });
route("/cosmetics", staticPage("Cosmetics", "This is the Cosmetics page."));
route("/designing-stitching", staticPage("Designing & Stitching", "This is the Designing & Stitching page."));
route("/about-us", staticPage("About Us", "This is the About Us page."));
route("/contact", staticPage("Contact", "This is the Contact page."));

// =============================================================== franchise (public form)
const FRANCHISE = {
  full_name: { type: "str", max: 200, required: true }, mobile_number: { type: "str", max: 20, required: true },
  whatsapp_number: { type: "str", max: 20, blank: true, nullable: true }, email: { type: "email", max: 254, required: true },
  age_group: { type: "str", max: 50, required: true }, current_city_district: { type: "str", max: 200, required: true },
  state: { type: "str", max: 100, required: true }, occupation: { type: "str", max: 200, required: true },
  has_business_exp: { type: "str", max: 20, required: true }, business_exp_details: { type: "str", blank: true, nullable: true },
  has_salon_exp: { type: "str", max: 20, required: true }, applicant_type: { type: "str", max: 100, required: true },
  preferred_city: { type: "str", max: 100, required: true }, preferred_area: { type: "str", max: 150, required: true },
  has_commercial_property: { type: "str", max: 100, required: true }, property_size: { type: "str", max: 100, blank: true, nullable: true },
  property_location_link: { type: "str", max: 500, blank: true, nullable: true }, investment_budget: { type: "str", max: 100, required: true },
  investment_source: { type: "str", max: 100, required: true }, plan_to_start: { type: "str", max: 100, required: true },
  daily_operations_involvement: { type: "str", max: 100, required: true },
  confirm_accurate: { type: "bool", default: true }, agree_contact: { type: "bool", default: true },
} as const;
route("/franchise", {
  // Previously this listed every enquiry (names, phones, budgets) to anyone. The page only needs a 200.
  GET: () => json({ page: "Franchise", data: [] }),
  POST: async ({ body }) => {
    const d = validate(await body(), FRANCHISE as any);
    for (const k of ["whatsapp_number", "business_exp_details", "property_size", "property_location_link"]) d[k] ??= null;
    const [row] = await sql`insert into app_franchiseenquiry ${sql({ ...d, created_at: new Date().toISOString() })} returning *`;
    const data = { ...row, created_at: iso(row.created_at) };
    await sendFranchiseEmails(data);
    return json({ message: "Franchise enquiry submitted successfully.", data }, 201);
  },
}, { noAuth: true });

// =============================================================== event hall (public form)
const EVENT = {
  name: { type: "str", max: 200, required: true }, phone: { type: "str", max: 20, required: true },
  email: { type: "email", max: 254, required: true },
  event_type: { type: "choice", choices: ["wedding", "reception", "birthday", "corporate", "other"], required: true },
  category: { type: "choice", choices: ["ac", "non-ac"], required: true },
  event_date: { type: "date", required: true },
} as const;
const eventJson = (e: any) => ({ id: e.id, name: e.name, phone: e.phone, email: e.email, event_type: e.event_type, category: e.category, event_date: e.event_date, created_at: iso(e.created_at) });
route("/event-hall", {
  // Previously listed every booking (names, phones, emails) publicly; the site never uses it.
  GET: () => json([]),
  POST: async ({ body }) => {
    // DRF runs every field check (incl. the custom date rules) and reports all errors together.
    const raw = await body();
    let d: Record<string, any> = {};
    let errors: Record<string, string[]> = {};
    try { d = validate(raw, EVENT as any); } catch (e) { if (e instanceof HttpError) errors = e.body as any; else throw e; }
    const date = d.event_date ?? (errors.event_date ? undefined : undefined);
    const dateOk = !errors.event_date && /^\d{4}-\d{2}-\d{2}$/.test(String(raw.event_date ?? ""));
    const ev = dateOk ? String(raw.event_date) : date;
    if (ev && !errors.event_date) {
      if (ev < todayIST()) errors.event_date = ["Booking date cannot be in the past."];
      else if ((await sql`select 1 from app_eventhall where event_date = ${ev} limit 1`).length) {
        errors.event_date = ["This date is already booked. Please select another date."];
      }
    }
    if (Object.keys(errors).length) throw bad(errors);
    const [row] = await sql`insert into app_eventhall ${sql({ ...d, created_at: new Date().toISOString() })} returning *`;
    await sendEventHallEmails(row as any);
    return json({ message: "Event hall booking enquiry submitted successfully.", data: eventJson(row) }, 201);
  },
}, { noAuth: true });
route("/event-hall/booked-dates", { GET: async () => {
  const rows = await sql`select distinct event_date from app_eventhall where event_date is not null order by event_date`;
  return json({ booked_dates: rows.map((r) => r.event_date) });
} }, { noAuth: true });

// =============================================================== accounts
const USERNAME_RE = /^[\w.@+-]+$/u;
route("/signup", { POST: async ({ body }) => {
  const data = await body();
  const errors: Record<string, string[]> = {};
  const username = String(data.username ?? "").trim();
  const email = String(data.email ?? "").trim();
  const password = data.password === undefined || data.password === null ? "" : String(data.password);
  if (data.username === undefined) errors.username = ["This field is required."];
  else if (!username) errors.username = ["This field may not be blank."];
  else if (username.length > 150) errors.username = ["Ensure this field has no more than 150 characters."];
  else if (username.toLowerCase().startsWith("guest_")) errors.username = ["This username is reserved. Please choose another."];
  else if (!USERNAME_RE.test(username)) errors.username = ["Enter a valid username. This value may contain only letters, numbers, and @/./+/-/_ characters."];
  else if ((await sql`select 1 from auth_user where username = ${username}`).length) errors.username = ["A user with that username already exists."];
  if (email) {
    if (!EMAIL_RE.test(email) || email.length > 254) errors.email = ["Enter a valid email address."];
    else if ((await sql`select 1 from auth_user where email = ${email} and left(username, 6) <> 'guest_'`).length) errors.email = ["Email already exists"];
  }
  if (data.password === undefined) errors.password = ["This field is required."];
  else if (!password.trim()) errors.password = ["This field may not be blank."];
  if (Object.keys(errors).length) throw bad(errors);

  const hash = await makePassword(password);
  const key = newTokenKey();
  await sql.begin(async (tx) => {
    const [u] = await tx`insert into auth_user (password, is_superuser, username, first_name, last_name, email, is_staff, is_active, date_joined)
                         values (${hash}, false, ${username}, '', '', ${email}, false, true, now()) returning id`;
    await tx`insert into authtoken_token (key, created, user_id) values (${key}, now(), ${u.id})`;
  });
  return json({ message: "Signup successful", token: key }, 201);
} });

route("/login", { POST: async ({ body }) => {
  const d = await body();
  const errors: Record<string, string[]> = {};
  if (d.username === undefined) errors.username = ["This field is required."];
  else if (!String(d.username).trim()) errors.username = ["This field may not be blank."];
  if (d.password === undefined) errors.password = ["This field is required."];
  else if (!String(d.password).trim()) errors.password = ["This field may not be blank."];
  if (Object.keys(errors).length) throw bad(errors);
  const [u] = await sql`select id, password, is_active from auth_user where username = ${String(d.username).trim()}`;
  if (!u || !u.is_active || !(await checkPassword(String(d.password), u.password))) {
    throw bad({ non_field_errors: ["Invalid username or password"] });
  }
  const [t] = await sql`insert into authtoken_token (key, created, user_id) values (${newTokenKey()}, now(), ${u.id})
                        on conflict (user_id) do update set user_id = excluded.user_id returning key`;
  await sql`update auth_user set last_login = now() where id = ${u.id}`;
  return json({ message: "Login successful", token: t.key });
} });

route("/logout", { POST: async ({ user }) => {
  const u = requireUser(user);
  await sql`delete from authtoken_token where user_id = ${u.id}`;
  return json({ message: "Logged out" });
} });

route("/profile", { GET: ({ user }) => {
  const u = requireUser(user);
  return json({ id: u.id, username: u.username, email: u.email, date_joined: iso(u.date_joined) });
} });

const emailOnly = (d: Record<string, any>) => {
  if (d.email === undefined) throw bad({ email: ["This field is required."] });
  const email = String(d.email).trim();
  if (!email) throw bad({ email: ["This field may not be blank."] });
  if (!EMAIL_RE.test(email)) throw bad({ email: ["Enter a valid email address."] });
  return email;
};

route("/forgot-password", { POST: async ({ body }) => {
  const email = emailOnly(await body());
  const [u] = await sql`select id, username, email, first_name, last_name from auth_user where email = ${email} and left(username, 6) <> 'guest_' order by id limit 1`;
  if (!u) return json({ message: "If the email exists, an OTP has been sent." });
  const otp = randomDigits(6);
  await sql`insert into app_passwordresetotp (email, otp, created_at, expires_at) values (${email}, ${otp}, now(), now() + interval '10 minutes')`;
  await sendPasswordResetOtpEmail(u as any, otp);
  return json({ message: "OTP sent to your email." });
} });

route("/reset-password", { POST: async ({ body }) => {
  const d = await body();
  const email = emailOnly(d);
  const errors: Record<string, string[]> = {};
  const otp = String(d.otp ?? "").trim();
  if (d.otp === undefined) errors.otp = ["This field is required."];
  else if (!otp) errors.otp = ["This field may not be blank."];
  else if (otp.length > 6) errors.otp = ["Ensure this field has no more than 6 characters."];
  if (d.new_password === undefined) errors.new_password = ["This field is required."];
  else if (!String(d.new_password).trim()) errors.new_password = ["This field may not be blank."];
  if (Object.keys(errors).length) throw bad(errors);

  // New: stop OTP guessing — after 5 wrong tries in 10 minutes, all OTPs for that email are cancelled.
  const [{ n }] = await sql`select count(*)::int as n from api_otp_failure where email = ${email} and at > now() - interval '10 minutes'`;
  if (n >= 5) {
    await sql`delete from app_passwordresetotp where email = ${email}`;
    throw bad({ message: "Too many wrong attempts. Please request a new OTP." });
  }
  const [row] = await sql`select id, expires_at < now() as expired from app_passwordresetotp
                          where email = ${email} and otp = ${otp} order by id desc limit 1`;
  if (!row) {
    await sql`insert into api_otp_failure (email, at) values (${email}, now())`;
    throw bad({ message: "Invalid OTP." });
  }
  if (row.expired) {
    await sql`delete from app_passwordresetotp where id = ${row.id}`;
    throw bad({ message: "OTP has expired." });
  }
  const [u] = await sql`select id from auth_user where email = ${email} and left(username, 6) <> 'guest_' order by id limit 1`;
  if (!u) throw bad({ message: "User not found." });
  await sql`update auth_user set password = ${await makePassword(String(d.new_password))} where id = ${u.id}`;
  await sql`delete from app_passwordresetotp where id = ${row.id}`;
  await sql`delete from api_otp_failure where email = ${email}`;
  return json({ message: "Password reset successful." });
} });

// =============================================================== products
route("/products", { GET: async ({ req }) => {
  const q = new URL(req.url).searchParams;
  const category = q.get("category");
  const search = q.get("search");
  const num = (v: string | null) => (v && /^-?\d+(\.\d+)?$/.test(v.trim()) ? v.trim() : null);
  const minP = num(q.get("min_price"));
  const maxP = num(q.get("max_price"));
  const products = await sql`
    select * from (
      select p.*, c.name as category_name, (select min(v.price) from app_productvariant v where v.product_id = p.id) as lowest_price
      from app_product p join app_category c on c.id = p.category_id
      where true
        ${category && category.toLowerCase() !== "all" ? sql`and upper(c.name) = upper(${category})` : sql``}
        ${search ? sql`and upper(p.title) like upper(${"%" + search.replace(/[\\%_]/g, (m) => "\\" + m) + "%"})` : sql``}
    ) x
    where true
      ${minP ? sql`and lowest_price >= ${minP}::numeric` : sql``}
      ${maxP ? sql`and lowest_price <= ${maxP}::numeric` : sql``}
    order by created_at desc`;
  const vmap = await variantsByProduct(products.map((p) => p.id));
  const categories = await sql`select id, name from app_category`; // Django: Category.objects.all(), no ordering
  return json({ products: products.map((p) => productJson(p, vmap.get(p.id) ?? [])), categories });
} });

route("/products/:id", { GET: async ({ params }) => {
  if (!/^\d+$/.test(params.id)) throw notFound();
  const [p] = await sql`select p.*, c.name as category_name from app_product p join app_category c on c.id = p.category_id where p.id = ${Number(params.id)}`;
  if (!p) throw notFound("Product not found");
  const vmap = await variantsByProduct([p.id]);
  return json(productJson(p, vmap.get(p.id) ?? [], true));
} });

// =============================================================== cart
async function cartIdFor(userId: number) {
  const [c] = await sql`insert into app_cart (created_at, user_id) values (now(), ${userId})
                        on conflict (user_id) do update set user_id = excluded.user_id returning id`;
  return c.id as number;
}

route("/cart", { GET: async ({ user }) => json(await cartJson(requireUser(user).id)) });

route("/cart/add", { POST: async ({ user, body }) => {
  const u = requireUser(user);
  const d = await body();
  const quantity = d.quantity === undefined ? 1 : toInt(d.quantity, "quantity");
  const [v] = /^\d+$/.test(String(d.variant_id ?? "")) ? await sql`select id, stock from app_productvariant where id = ${Number(d.variant_id)}` : [];
  if (!v) return json({ error: "Variant not found" }, 404);
  if (v.stock < quantity) return json({ error: "Not enough stock" }, 400);
  const cartId = await cartIdFor(u.id);
  const [existing] = await sql`select id, quantity from app_cartitem where cart_id = ${cartId} and variant_id = ${v.id}`;
  if (!existing) {
    await sql`insert into app_cartitem (quantity, cart_id, variant_id) values (${quantity}, ${cartId}, ${v.id})`;
  } else {
    if (existing.quantity + quantity > v.stock) return json({ error: "Stock limit reached" }, 400);
    await sql`update app_cartitem set quantity = quantity + ${quantity} where id = ${existing.id}`;
  }
  return json({ message: "Added to cart successfully" });
} });

route("/cart/update", { POST: async ({ user, body }) => {
  const u = requireUser(user);
  const d = await body();
  const quantity = toInt(d.quantity, "quantity");
  const [item] = /^\d+$/.test(String(d.item_id ?? "")) ? await sql`
    select ci.id, v.stock from app_cartitem ci join app_cart c on c.id = ci.cart_id join app_productvariant v on v.id = ci.variant_id
    where ci.id = ${Number(d.item_id)} and c.user_id = ${u.id}` : [];
  if (!item) return json({ error: "Cart item not found" }, 404);
  if (quantity < 1) {
    await sql`delete from app_cartitem where id = ${item.id}`;
    return json({ message: "Item removed from cart" });
  }
  if (quantity > item.stock) return json({ error: "Stock limit exceeded" }, 400);
  await sql`update app_cartitem set quantity = ${quantity} where id = ${item.id}`;
  return json({ message: "Quantity updated successfully" });
} });

route("/cart/remove", { POST: async ({ user, body }) => {
  const u = requireUser(user);
  const d = await body();
  const r = /^\d+$/.test(String(d.item_id ?? "")) ? await sql`
    delete from app_cartitem ci using app_cart c where ci.cart_id = c.id and c.user_id = ${u.id} and ci.id = ${Number(d.item_id)} returning ci.id` : [];
  if (!r.length) return json({ error: "Item not found" }, 404);
  return json({ message: "Item removed" });
} });

// =============================================================== wishlist
const variantIdOr400 = (d: Record<string, any>) => {
  if (!d.variant_id) throw bad({ error: "variant_id is required" });
  return /^\d+$/.test(String(d.variant_id)) ? Number(d.variant_id) : -1;
};
route("/wishlist", { GET: async ({ user }) => json(await wishlistJson(requireUser(user).id)) });

route("/wishlist/add", { POST: async ({ user, body }) => {
  const u = requireUser(user);
  const vid = variantIdOr400(await body());
  const [v] = await sql`select id from app_productvariant where id = ${vid}`;
  if (!v) return json({ error: "Variant not found" }, 404);
  const wid = await wishlistId(u.id);
  const r = await sql`insert into app_wishlistitem (variant_id, wishlist_id) values (${vid}, ${wid}) on conflict do nothing returning id`;
  return r.length ? json({ message: "Added to wishlist" }, 201) : json({ message: "Already in wishlist" });
} });

route("/wishlist/remove", { POST: async ({ user, body }) => {
  const u = requireUser(user);
  const vid = variantIdOr400(await body());
  const r = await sql`delete from app_wishlistitem wi using app_wishlist w
                      where wi.wishlist_id = w.id and w.user_id = ${u.id} and wi.variant_id = ${vid} returning wi.id`;
  return r.length ? json({ message: "Removed from wishlist" }) : json({ error: "Item not found" }, 404);
} });

route("/wishlist/toggle", { POST: async ({ user, body }) => {
  const u = requireUser(user);
  const vid = variantIdOr400(await body());
  const [v] = await sql`select id from app_productvariant where id = ${vid}`;
  if (!v) return json({ error: "Variant not found" }, 404);
  const wid = await wishlistId(u.id);
  const del = await sql`delete from app_wishlistitem where wishlist_id = ${wid} and variant_id = ${vid} returning id`;
  if (del.length) return json({ toggled: false, message: "Removed from wishlist" });
  await sql`insert into app_wishlistitem (variant_id, wishlist_id) values (${vid}, ${wid}) on conflict do nothing`;
  return json({ toggled: true, message: "Added to wishlist" }, 201);
} });

// =============================================================== addresses
const ADDRESS = {
  label: { type: "str", max: 100, blank: true, nullable: true }, line1: { type: "str", max: 255, required: true },
  line2: { type: "str", max: 255, blank: true, nullable: true }, city: { type: "str", max: 100, required: true },
  state: { type: "str", max: 100, required: true }, postal_code: { type: "str", max: 20, required: true },
  country: { type: "str", max: 100 }, phone: { type: "str", max: 30, required: true },
  is_default: { type: "bool" },
} as const;

/** Mobile number is mandatory on addresses: 10 digits, Indian mobile (6-9…). Stores the 10 digits. */
function checkPhone(d: Record<string, any>, partial: boolean) {
  if (partial && d.phone === undefined) return d;
  const digits = String(d.phone ?? "").replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, "");
  if (!/^[6-9]\d{9}$/.test(digits)) throw bad({ phone: ["Enter a valid 10-digit mobile number."] });
  return { ...d, phone: digits };
}

route("/addresses", {
  GET: async ({ user }) => {
    const u = requireUser(user);
    return json((await sql`select * from app_address where user_id = ${u.id} order by is_default desc, created_at desc`).map(addressJson));
  },
  POST: async ({ user, body }) => {
    const u = requireUser(user);
    const d = checkPhone(validate(await body(), ADDRESS as any), false);
    const row = { label: null, line2: null, state: null, phone: null, country: "India", is_default: false, ...d };
    const [a] = await sql.begin(async (tx) => {
      if (row.is_default) await tx`update app_address set is_default = false where user_id = ${u.id} and is_default`;
      return tx`insert into app_address ${sql({ ...row, user_id: u.id, created_at: new Date().toISOString() })} returning *`;
    });
    return json(addressJson(a), 201);
  },
});

async function ownAddress(u: User, id: string) {
  const [a] = /^\d+$/.test(id) ? await sql`select * from app_address where id = ${Number(id)} and user_id = ${u.id}` : [];
  if (!a) throw notFound("No Address matches the given query.");
  return a;
}
async function updateAddress(u: User, id: string, data: Record<string, any>, partial: boolean) {
  const a = await ownAddress(u, id);
  const d = checkPhone(validate(data, ADDRESS as any, partial), partial);
  const [row] = await sql.begin(async (tx) => {
    if (d.is_default) await tx`update app_address set is_default = false where user_id = ${u.id} and is_default and id <> ${a.id}`;
    return Object.keys(d).length ? tx`update app_address set ${sql(d)} where id = ${a.id} returning *` : [a];
  });
  return json(addressJson(row));
}
route("/addresses/:id", {
  GET: async ({ user, params }) => json(addressJson(await ownAddress(requireUser(user), params.id))),
  PUT: async ({ user, params, body }) => updateAddress(requireUser(user), params.id, await body(), false),
  PATCH: async ({ user, params, body }) => updateAddress(requireUser(user), params.id, await body(), true),
  DELETE: async ({ user, params }) => {
    const u = requireUser(user);
    const a = await ownAddress(u, params.id);
    await sql.begin(async (tx) => {
      // Django's on_delete=SET_NULL for orders that used this address
      await tx`update app_order set shipping_address_id = null where shipping_address_id = ${a.id}`;
      await tx`update app_order set billing_address_id = null where billing_address_id = ${a.id}`;
      await tx`delete from app_address where id = ${a.id}`;
    });
    return json(null, 204);
  },
});

// =============================================================== guest (express) checkout
const GUEST_PREFIX = "guest_";
const isGuest = (username: string | null | undefined) => String(username ?? "").startsWith(GUEST_PREFIX);

// Fresh price/stock for a browser-side (guest) cart.
route("/variants/lookup", { POST: async ({ body }) => {
  const d = await body();
  const ids = [...new Set((Array.isArray(d.ids) ? d.ids : []).map(Number).filter((n: number) => Number.isInteger(n) && n > 0))].slice(0, 100);
  if (!ids.length) return json([]);
  const rows = await sql`select v.id, v.quantity_label, v.mrp, v.price, v.stock, v.sku, v.product_id, p.title, p.brand, p.image1
                         from app_productvariant v join app_product p on p.id = v.product_id where v.id in ${sql(ids)}`;
  return json(rows.map(variantJson));
} });

/**
 * Express checkout without an account: name, email, mobile, address and the browser cart.
 * Creates (or reuses) a private guest record so payment, emails, WhatsApp and admin work as for members.
 * Returns the Razorpay checkout payload plus a guest token that only gives access to this guest's own order.
 */
route("/guest/checkout", { POST: async ({ user, body }) => {
  const d = await body();
  const errors: Record<string, string[]> = {};
  const name = String(d.name ?? "").trim().replace(/\s+/g, " ").slice(0, 150);
  const email = String(d.email ?? "").trim().toLowerCase();
  if (name.length < 2) errors.name = ["Please enter your name."];
  if (!EMAIL_RE.test(email) || email.length > 254) errors.email = ["Enter a valid email address."];
  let addr: Record<string, any> = {};
  try {
    addr = checkPhone(validate({ ...d, label: "Home", country: "India", is_default: true }, ADDRESS as any), false);
  } catch (e) {
    if (e instanceof HttpError) Object.assign(errors, (e as any).body ?? {}); else throw e;
  }
  const lines = (Array.isArray(d.items) ? d.items : []).slice(0, 50)
    .map((i: any) => ({ variant_id: Number(i?.variant_id), quantity: Math.min(20, Math.max(1, Number(i?.quantity) || 1)) }))
    .filter((i: any) => Number.isInteger(i.variant_id) && i.variant_id > 0);
  if (!lines.length) errors.items = ["Your cart is empty."];
  if (Object.keys(errors).length) throw bad(errors);

  const variants = await sql`select id, stock from app_productvariant where id in ${sql(lines.map((l: any) => l.variant_id))}`;
  const stock = new Map(variants.map((v: any) => [v.id, v.stock]));
  const missing = lines.filter((l: any) => !stock.has(l.variant_id) || stock.get(l.variant_id) < 1);
  if (missing.length) return json({ error: "Some items in your cart are no longer available. Please remove them and try again." }, 400);

  const [first, ...rest] = name.split(" ");
  const reuse = user && isGuest(user.username) ? user.id : null; // same browser retrying: reuse the guest record
  const { userId, token, shipping } = await sql.begin(async (tx) => {
    let userId = reuse as number | null;
    if (userId) {
      await tx`update auth_user set first_name = ${first.slice(0, 150)}, last_name = ${rest.join(" ").slice(0, 150)}, email = ${email} where id = ${userId}`;
    } else {
      const username = GUEST_PREFIX + newTokenKey().slice(0, 16);
      // "!" + random = Django's "unusable password": nobody can log in to a guest record.
      const [u] = await tx`insert into auth_user (password, is_superuser, username, first_name, last_name, email, is_staff, is_active, date_joined)
                           values (${"!" + newTokenKey()}, false, ${username}, ${first.slice(0, 150)}, ${rest.join(" ").slice(0, 150)},
                                   ${email}, false, true, now()) returning id`;
      userId = u.id as number;
    }
    const [t] = await tx`insert into authtoken_token (key, created, user_id) values (${newTokenKey()}, now(), ${userId})
                         on conflict (user_id) do update set user_id = excluded.user_id returning key`;
    await tx`update app_address set is_default = false where user_id = ${userId} and is_default`;
    const [shipping] = await tx`insert into app_address ${sql({ ...addr, user_id: userId, created_at: new Date().toISOString() })} returning *`;
    const [c] = await tx`insert into app_cart (created_at, user_id) values (now(), ${userId})
                         on conflict (user_id) do update set user_id = excluded.user_id returning id`;
    await tx`delete from app_cartitem where cart_id = ${c.id}`;
    for (const l of lines) {
      await tx`insert into app_cartitem (quantity, cart_id, variant_id) values (${l.quantity}, ${c.id}, ${l.variant_id})`;
    }
    return { userId: userId!, token: t.key as string, shipping };
  });

  const out = await startRazorpayOrder(userId, shipping, shipping);
  if (out instanceof Response) return out;
  return json({ ...out, guest_token: token });
} });

// =============================================================== payments
/** Turn the user's cart into a pending order + Razorpay order. Returns the checkout payload, or an error response. */
async function startRazorpayOrder(userId: number, shipping: any, billing: any) {
  const u = { id: userId };
  const cartId = await cartIdFor(u.id);
  const items = await sql`select ci.quantity, v.id as variant_id, v.price from app_cartitem ci
                          join app_productvariant v on v.id = ci.variant_id where ci.cart_id = ${cartId} order by ci.id`;
  if (!items.length) return json({ error: "Cart is empty" }, 400);
  const subtotal = items.reduce((s, i) => s + i.quantity * paise(i.price), 0);
  const ship = await shippingFor(shipping.state, shipping.city, subtotal); // city field holds the district
  const total = subtotal + ship;

  let rzpOrder: any;
  try {
    rzpOrder = await rzp("/orders", { amount: total, currency: "INR", payment_capture: 1 });
  } catch (e) {
    return json({ error: `Failed to create payment order: ${(e as Error).message}` }, 400);
  }

  const orderId = await sql.begin(async (tx) => {
    const [o] = await tx`insert into app_order (total_amount, shipping_cost, status, payment_method, payment_status, transaction_id,
                           created_at, updated_at, billing_address_id, shipping_address_id, user_id)
                         values (${money(total)}, ${money(ship)}, 'pending', 'razorpay', 'unpaid', ${rzpOrder.id}, now(), now(),
                           ${billing.id}, ${shipping.id}, ${u.id}) returning id`;
    for (const i of items) {
      await tx`insert into app_orderitem (quantity, unit_price, total_price, order_id, variant_id)
               values (${i.quantity}, ${i.price}, ${money(i.quantity * paise(i.price))}, ${o.id}, ${i.variant_id})`;
    }
    await tx`insert into app_paymenttransaction (razorpay_order_id, amount, status, shipping_address_id, billing_address_id, created_at, order_id, user_id)
             values (${rzpOrder.id}, ${money(total)}, 'created', ${shipping.id}, ${billing.id}, now(), ${o.id}, ${u.id})`;
    return o.id as number;
  });

  return {
    order_id: rzpOrder.id, db_order_id: orderId, amount: total / 100, currency: "INR", key: razorpayKeyId(),
    subtotal: subtotal / 100, shipping: ship / 100,
  };
}

// Shipping rates for the cart page (the server recalculates at payment, so this is display only).
route("/shipping/rates", { GET: async () => {
  const { rates, freeAbove } = await shippingRules();
  return json({ free_above: freeAbove, rates });
} });

route("/payment/create", { POST: async ({ user, body }) => {
  const u = requireUser(user);
  const d = await body();
  const pick = async (id: unknown) =>
    id && /^\d+$/.test(String(id)) ? (await sql`select * from app_address where id = ${Number(id)} and user_id = ${u.id}`)[0] : undefined;
  let shipping = await pick(d.shipping_address_id);
  if (!shipping) [shipping] = await sql`select * from app_address where user_id = ${u.id} order by is_default desc, id desc limit 1`;
  if (!shipping) return json({ error: "Please provide a valid shipping address" }, 400);
  if (!/^[6-9]\d{9}$/.test(String(shipping.phone ?? "").replace(/\D/g, "").replace(/^(91|0)(?=\d{10}$)/, ""))) {
    return json({ error: "Please add a 10-digit mobile number to your delivery address." }, 400);
  }
  const billing = (await pick(d.billing_address_id)) ?? shipping;

  const out = await startRazorpayOrder(u.id, shipping, billing);
  return out instanceof Response ? out : json(out);
} });

/** Fallback used by verify + webhook when no order exists yet for a paid Razorpay order. */
async function createPaidOrderFromTx(tx: typeof sql, t: any, paymentId: string, withCartItems: boolean) {
  let [ship] = t.shipping_address_id ? await tx`select id from app_address where id = ${t.shipping_address_id} and user_id = ${t.user_id}` : [];
  if (!ship && !withCartItems) [ship] = await tx`select id from app_address where user_id = ${t.user_id} order by is_default desc, id desc limit 1`;
  let [bill] = withCartItems && t.billing_address_id ? await tx`select id from app_address where id = ${t.billing_address_id} and user_id = ${t.user_id}` : [];
  bill ??= ship;
  const [o] = await tx`insert into app_order (total_amount, shipping_cost, status, payment_method, payment_status, transaction_id,
                         created_at, updated_at, billing_address_id, shipping_address_id, user_id)
                       values (${t.amount}, 0, 'confirmed', 'razorpay', 'paid', ${paymentId}, now(), now(),
                         ${bill?.id ?? null}, ${ship?.id ?? null}, ${t.user_id}) returning id`;
  if (withCartItems) {
    const items = await tx`select ci.id, ci.quantity, v.id as variant_id, v.price from app_cartitem ci
                           join app_cart c on c.id = ci.cart_id join app_productvariant v on v.id = ci.variant_id
                           where c.user_id = ${t.user_id} order by ci.id`;
    for (const i of items) {
      await tx`insert into app_orderitem (quantity, unit_price, total_price, order_id, variant_id)
               values (${i.quantity}, ${i.price}, ${money(i.quantity * paise(i.price))}, ${o.id}, ${i.variant_id})`;
      await tx`update app_productvariant set stock = greatest(0, stock - ${i.quantity}) where id = ${i.variant_id}`;
    }
  }
  await tx`delete from app_cartitem where cart_id in (select id from app_cart where user_id = ${t.user_id})`;
  return o.id as number;
}

route("/payment/verify", { POST: async ({ user, body }) => {
  const u = requireUser(user);
  const d = await body();
  const { razorpay_order_id: oid, razorpay_payment_id: pid, razorpay_signature: sig } = d;
  if (!oid || !pid || !sig) return json({ error: "Missing payment information" }, 400);

  const result = await sql.begin(async (tx) => {
    const [existing] = await tx`select id from app_order where transaction_id = ${pid} limit 1`;
    if (existing) return { already: existing.id };
    const [t] = await tx`select * from app_paymenttransaction where razorpay_order_id = ${oid} and user_id = ${u.id} order by id limit 1 for update`;
    if (t && t.status === "success" && t.order_id) return { already: t.order_id };
    if (!(await verifyPaymentSignature(String(oid), String(pid), String(sig)))) {
      if (t) await tx`update app_paymenttransaction set status = 'failed' where id = ${t.id}`;
      return { failed: true };
    }
    let orderId: number | null = t?.order_id ?? null;
    if (!orderId) {
      const [o] = await tx`select id from app_order where transaction_id = ${oid} limit 1`;
      orderId = o?.id ?? null;
    }
    let newlyPaid = true;
    if (orderId) {
      newlyPaid = await markOrderPaid(tx as any, orderId, String(pid), String(oid), String(sig));
    } else {
      orderId = await createPaidOrderFromTx(tx as any, t ?? { user_id: u.id, amount: "0.00" }, String(pid), false);
      if (t) await tx`update app_paymenttransaction set order_id = ${orderId}, razorpay_payment_id = ${pid},
                      razorpay_signature = ${sig}, status = 'success' where id = ${t.id}`;
    }
    await tx`delete from app_cartitem where cart_id in (select id from app_cart where user_id = ${u.id})`;
    return { orderId, newlyPaid };
  });

  if ("failed" in result) return json({ error: "Payment verification failed" }, 400);
  if ("already" in result) return json({ message: "Payment already verified", order_id: result.already });
  if (result.newlyPaid) background(notifyOrder(result.orderId!));
  return json({ message: "Payment verified successfully", order_id: result.orderId });
} });

// Razorpay webhook (payment.captured) — safety net for missed verifications.
route("/payment/webhook", { POST: async ({ req }) => {
  const raw = new Uint8Array(await req.arrayBuffer());
  let data: any;
  try { data = JSON.parse(new TextDecoder().decode(raw)); } catch { return json({ error: "Invalid JSON" }, 400); }
  const secret = Deno.env.get("RAZORPAY_WEBHOOK_SECRET") ?? "";
  if (secret && !(await verifyWebhookSignature(secret, raw, req.headers.get("x-razorpay-signature") ?? ""))) {
    return json({ error: "Invalid signature" }, 400);
  }
  if (data?.event !== "payment.captured") return json({ status: "ignored" });
  const p = data?.payload?.payment?.entity ?? {};
  const pid: string | undefined = p.id;
  const oid: string | undefined = p.order_id;
  if (!pid || !oid) return json({ status: "missing_ids" });
  if (!secret) {
    // Without a webhook secret, anyone could fake this call — so confirm with Razorpay directly.
    try {
      const real = await rzp(`/payments/${pid}`);
      if (real.order_id !== oid || !(real.status === "captured" || real.captured)) return json({ status: "not_captured" });
    } catch { return json({ status: "unverified" }); }
  }
  const result = await sql.begin(async (tx) => {
    if ((await tx`select 1 from app_order where transaction_id = ${pid} limit 1`).length) return { status: "already_processed" };
    const [t] = await tx`select * from app_paymenttransaction where razorpay_order_id = ${oid} order by id limit 1 for update`;
    if (!t) return { status: "no_transaction" };
    const [o] = t.order_id ? [{ id: t.order_id }] : await tx`select id from app_order where transaction_id = ${oid} limit 1`;
    if (o) {
      const newlyPaid = await markOrderPaid(tx as any, o.id, pid, oid);
      await tx`update app_paymenttransaction set order_id = ${o.id}, razorpay_payment_id = ${pid}, status = 'success' where id = ${t.id}`;
      return { status: "order_confirmed", order_id: o.id, newlyPaid };
    }
    const newId = await createPaidOrderFromTx(tx as any, t, pid, true);
    await tx`update app_paymenttransaction set order_id = ${newId}, razorpay_payment_id = ${pid}, status = 'success' where id = ${t.id}`;
    return { status: "order_created", order_id: newId, newlyPaid: true };
  });
  const { newlyPaid, ...out } = result as any;
  if (out.order_id && newlyPaid) background(notifyOrder(out.order_id));
  return json(out);
} }, { noAuth: true });

// =============================================================== orders
route("/orders", { GET: async ({ user }) => {
  const u = requireUser(user);
  const pending = await sql`select id, payment_status, transaction_id from app_order
                            where user_id = ${u.id} and payment_status = 'unpaid' and payment_method = 'razorpay'
                            order by created_at desc limit 5`;
  for (const o of pending) await syncOrderWithRazorpay(o as any);
  const orders = await sql`select * from app_order where user_id = ${u.id} order by created_at desc`;
  return json(await ordersJson(orders, true));
} });

route("/orders/:id", { GET: async ({ user, params }) => {
  const u = requireUser(user);
  const [o] = /^\d+$/.test(params.id) ? await sql`select * from app_order where id = ${Number(params.id)} and user_id = ${u.id}` : [];
  if (!o) throw notFound("No Order matches the given query.");
  return json((await ordersJson([o], false))[0]);
} });

// =============================================================== admin panel API
adminRoutes(route);

// =============================================================== server
Deno.serve(async (req) => {
  const cors = corsHeaders(req);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const withCors = (r: Response) => { for (const [k, v] of Object.entries(cors)) r.headers.set(k, v); return r; };
  try {
    const path = new URL(req.url).pathname.replace(/^\/functions\/v1/, "").replace(/^\/api(?=\/|$)/, "") || "/";
    const r = routes.find((x) => x.pattern.test(path));
    if (!r) throw notFound();
    const handler = r.methods[req.method] ?? (req.method === "HEAD" ? r.methods.GET : undefined);
    if (!handler) throw new HttpError(405, { detail: `Method "${req.method}" not allowed.` });
    const m = path.match(r.pattern)!;
    const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
    const user = r.noAuth ? null : await authenticate(req);
    let cached: Promise<Record<string, any>> | null = null;
    const res = await handler({ req, user, params, body: () => (cached ??= readBody(req)) });
    return withCors(res);
  } catch (e) {
    if (e instanceof HttpError) {
      const res = json(e.body, e.status);
      if (e.status === 401) res.headers.set("WWW-Authenticate", "Token");
      return withCors(res);
    }
    console.error(e);
    return withCors(json({ detail: "Something went wrong. Please try again." }, 500));
  }
});
