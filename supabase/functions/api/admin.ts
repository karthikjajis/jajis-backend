// Admin API used by the new Jaji's admin panel (replaces /admin and /ecommerce/admin in Django).
// Every route needs a staff user's token (is_staff = true in auth_user).
import { sql, iso, money, paise } from "./db.ts";
import { bad, checkPassword, HttpError, img, json, newTokenKey, notFound, type User } from "./util.ts";
import { clearShippingCache, emailOrder, ordersJson, syncOrderWithRazorpay, whatsappOrder, whatsappShipped } from "./shop.ts";
import { emailStatus, sendTestEmail } from "./email.ts";
import { adminNumbers, sendTemplate, WA, whatsappConfigured } from "./whatsapp.ts";

type Ctx = { req: Request; user: User | null; params: Record<string, string>; body: () => Promise<Record<string, any>> };
type RouteFn = (path: string, methods: Record<string, (c: Ctx) => Promise<Response> | Response>, opts?: { noAuth?: boolean }) => void;

function staff(u: User | null): User {
  if (!u) throw new HttpError(401, { detail: "Please log in." });
  if (!u.is_staff) throw new HttpError(403, { detail: "Only staff accounts can use the admin panel." });
  return u;
}
const id = (v: string) => { if (!/^\d+$/.test(v)) throw notFound(); return Number(v); };

// ------------------------------------------------------------------ editable tables
type Col = { t: "str" | "text" | "img" | "money" | "int" | "fk" | "bool" | "date" | "choice"; max?: number; req?: boolean; nullable?: boolean; choices?: string[]; def?: unknown };
type Res = { table: string; cols: Record<string, Col>; order: string; created?: string; updated?: string; readOnly?: boolean; search?: string[] };

const S = (max: number, req = true): Col => ({ t: "str", max, req, nullable: !req });
const IMG = (req = false): Col => ({ t: "img", max: 100, req, nullable: !req });
const RES: Record<string, Res> = {
  categories: { table: "app_category", order: "name", cols: { name: S(150) }, search: ["name"] },
  products: {
    table: "app_product", order: "created_at desc", created: "created_at", updated: "updated_at", search: ["title", "brand", "description"],
    cols: {
      category_id: { t: "fk", req: true }, title: S(255), description: { t: "text", req: true },
      brand: { ...S(100, false), def: "jajis" }, image1: IMG(true), image2: IMG(), image3: IMG(), image4: IMG(),
    },
  },
  variants: {
    table: "app_productvariant", order: "id",
    cols: { product_id: { t: "fk", req: true }, quantity_label: S(50), mrp: { t: "money", req: true }, price: { t: "money", req: true }, stock: { t: "int", req: true, def: 0 }, sku: S(100, false) },
  },
  banners: { table: "app_bannerimage", order: "uploaded_at desc", created: "uploaded_at", cols: { image: IMG() } },
  salons: {
    table: "app_saloon", order: "id", search: ["name", "location"],
    cols: {
      name: S(200), location: S(300), description: { t: "text", req: true }, google_map_url: S(1000, false),
      image: IMG(true), image1: IMG(), image2: IMG(), image3: IMG(), image4: IMG(), image5: IMG(), image6: IMG(),
    },
  },
  food: { table: "app_foodmenu", order: "id", search: ["title"], cols: { title: S(200), description: { t: "text", req: true }, price: { t: "money", req: true }, image: IMG(true) } },
  cosmetics: { table: "app_cosmetics", order: "id", search: ["title"], cols: { title: S(200), description: { t: "text", req: true }, price: { t: "money", req: true }, image: IMG(true) } },
  courses: { table: "app_courses", order: "id", search: ["course"], cols: { course: S(100), duration: S(100), description: { t: "text", req: true }, image: IMG(true) } },
  eventhall: {
    table: "app_eventhall", order: "event_date desc", created: "created_at", search: ["name", "phone", "email"],
    cols: {
      name: S(200), phone: S(20), email: S(254), event_date: { t: "date", req: true },
      event_type: { t: "choice", req: true, choices: ["wedding", "reception", "birthday", "corporate", "other"] },
      category: { t: "choice", req: true, choices: ["ac", "non-ac"] },
    },
  },
  shipping: {
    table: "app_shipping_rate", order: "state", search: ["state", "district"],
    cols: { state: S(100), district: S(100, false), amount: { t: "money", req: true } },
  },
  franchise: { table: "app_franchiseenquiry", order: "created_at desc", created: "created_at", readOnly: true, cols: {}, search: ["full_name", "email", "mobile_number", "preferred_city"] },
};

function clean(res: Res, data: Record<string, any>, partial: boolean) {
  const out: Record<string, any> = {};
  const errors: Record<string, string> = {};
  for (const [k, c] of Object.entries(res.cols)) {
    if (!(k in data)) {
      if (!partial) {
        if (c.def !== undefined) out[k] = c.def;
        else if (c.req) errors[k] = "Required";
      }
      continue;
    }
    let v = data[k];
    if (v === "" || v === undefined) v = null;
    if (v === null) {
      if (c.req) errors[k] = "Required";
      else out[k] = c.t === "bool" ? false : null;
      continue;
    }
    switch (c.t) {
      case "str": case "img": case "text":
        v = String(v).trim();
        if (c.max && v.length > c.max) errors[k] = `Max ${c.max} characters`;
        else out[k] = v;
        break;
      case "money":
        if (!/^\d{1,8}(\.\d{1,2})?$/.test(String(v).trim())) errors[k] = "Enter an amount like 499 or 499.50";
        else out[k] = money(paise(String(v).trim()));
        break;
      case "int": case "fk":
        if (!/^\d+$/.test(String(v).trim())) errors[k] = "Enter a whole number";
        else out[k] = Number(v);
        break;
      case "bool": out[k] = v === true || v === "true"; break;
      case "date":
        if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) errors[k] = "Use YYYY-MM-DD";
        else out[k] = String(v);
        break;
      case "choice":
        if (!c.choices!.includes(String(v))) errors[k] = `Choose one of: ${c.choices!.join(", ")}`;
        else out[k] = String(v);
        break;
    }
  }
  if (Object.keys(errors).length) throw bad({ errors });
  return out;
}

const rowOut = (r: any) => {
  const o: any = { ...r };
  for (const k of ["created_at", "updated_at", "uploaded_at"]) if (k in o) o[k] = iso(o[k]);
  return o;
};

// ------------------------------------------------------------------ deletes that Django's on_delete rules handled
async function deleteVariants(tx: typeof sql, variantIds: number[]) {
  if (!variantIds.length) return;
  const [{ n }] = await tx`select count(*)::int as n from app_orderitem where variant_id in ${tx(variantIds)}`;
  if (n) throw bad({ detail: "This has been ordered by customers, so it can't be deleted (order history must stay). Set its stock to 0 instead." });
  await tx`delete from app_cartitem where variant_id in ${tx(variantIds)}`;
  await tx`delete from app_wishlistitem where variant_id in ${tx(variantIds)}`;
  await tx`delete from app_productvariant where id in ${tx(variantIds)}`;
}

// ------------------------------------------------------------------ Cloudinary signed upload
async function sha1hex(s: string) {
  const h = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const FOLDERS = ["product_images", "banner_image", "saloon_images", "food_images", "cosmetics_images", "courses"];

// ------------------------------------------------------------------ routes
export function adminRoutes(route: RouteFn) {
  route("/admin/login", { POST: async ({ body }) => {
    const d = await body();
    const [u] = await sql`select id, password, is_active, is_staff, username from auth_user where username = ${String(d.username ?? "").trim()}`;
    if (!u || !u.is_active || !(await checkPassword(String(d.password ?? ""), u.password))) throw bad({ detail: "Wrong username or password." });
    if (!u.is_staff) throw new HttpError(403, { detail: "This account is not a staff account." });
    const [t] = await sql`insert into authtoken_token (key, created, user_id) values (${newTokenKey()}, now(), ${u.id})
                          on conflict (user_id) do update set user_id = excluded.user_id returning key`;
    await sql`update auth_user set last_login = now() where id = ${u.id}`;
    return json({ token: t.key, username: u.username });
  } });

  route("/admin/me", { GET: ({ user }) => {
    const u = staff(user);
    return json({ id: u.id, username: u.username, email: u.email, cloud_name: Deno.env.get("CLOUDINARY_CLOUD_NAME") ?? "" });
  } });

  route("/admin/dashboard", { GET: async ({ user }) => {
    staff(user);
    const [[o], [rev], [cust], lowStock, recent, [leads]] = await Promise.all([
      sql`select count(*)::int as total,
            count(*) filter (where payment_status = 'paid' and status in ('confirmed','processing'))::int as to_ship,
            count(*) filter (where payment_status = 'unpaid')::int as unpaid,
            count(*) filter (where created_at > now() - interval '30 days' and payment_status = 'paid')::int as paid_30d
          from app_order`,
      sql`select coalesce(sum(total_amount), 0) as month from app_order where payment_status = 'paid' and created_at > now() - interval '30 days'`,
      sql`select count(*)::int as total, count(*) filter (where date_joined > now() - interval '30 days')::int as new_30d from auth_user`,
      sql`select v.id, v.quantity_label, v.stock, p.title, p.id as product_id from app_productvariant v join app_product p on p.id = v.product_id
          where v.stock <= 5 order by v.stock, p.title limit 20`,
      sql`select o.id, o.total_amount, o.status, o.payment_status, o.created_at, u.username from app_order o join auth_user u on u.id = o.user_id
          order by o.created_at desc limit 8`,
      sql`select (select count(*)::int from app_franchiseenquiry where created_at > now() - interval '30 days') as franchise_30d,
                 (select count(*)::int from app_eventhall where event_date >= current_date) as upcoming_events`,
    ]);
    return json({ orders: o, revenue_30d: rev.month, customers: cust, low_stock: lowStock, recent_orders: recent.map(rowOut), leads });
  } });

  route("/admin/upload-signature", { POST: async ({ user, body }) => {
    staff(user);
    const { folder } = await body();
    if (!FOLDERS.includes(folder)) throw bad({ detail: "Unknown image folder" });
    const cloud = Deno.env.get("CLOUDINARY_CLOUD_NAME"), key = Deno.env.get("CLOUDINARY_API_KEY"), secret = Deno.env.get("CLOUDINARY_API_SECRET");
    if (!cloud || !key || !secret) throw bad({ detail: "Cloudinary settings are missing in Supabase (CLOUDINARY_CLOUD_NAME / API_KEY / API_SECRET)." });
    const params: Record<string, string> = {
      folder: `media/${folder}`, timestamp: String(Math.floor(Date.now() / 1000)), unique_filename: "true", use_filename: "true",
    };
    const toSign = Object.keys(params).sort().map((k) => `${k}=${params[k]}`).join("&");
    return json({ ...params, api_key: key, cloud_name: cloud, signature: await sha1hex(toSign + secret) });
  } });

  // ---------------- generic tables
  route("/admin/r/:res", {
    GET: async ({ user, params, req }) => {
      staff(user);
      const r = RES[params.res]; if (!r) throw notFound();
      const q = new URL(req.url).searchParams;
      const term = q.get("q")?.trim();
      const productId = q.get("product_id");
      const rows = await sql`select * from ${sql(r.table)} where true
        ${productId && params.res === "variants" ? sql`and product_id = ${id(productId)}` : sql``}
        ${term && r.search ? sql`and (${r.search.map((c, i) => sql`${i ? sql`or` : sql``} ${sql(c)}::text ilike ${"%" + term + "%"}`)})` : sql``}
        order by ${sql(r.order.split(' ')[0])} ${r.order.endsWith(' desc') ? sql`desc` : sql``} limit 1000`;
      let out = rows.map(rowOut);
      if (params.res === "products") {
        const stats = await sql`select product_id, count(*)::int as variants, coalesce(sum(stock),0)::int as stock, min(price) as from_price
                                from app_productvariant group by product_id`;
        const cats = await sql`select id, name from app_category`;
        const sm = new Map(stats.map((s: any) => [s.product_id, s]));
        const cm = new Map(cats.map((c: any) => [c.id, c.name]));
        out = out.map((p: any) => ({ ...p, category_name: cm.get(p.category_id), ...(sm.get(p.id) ?? { variants: 0, stock: 0, from_price: null }) }));
      }
      return json(out);
    },
    POST: async ({ user, params, body }) => {
      staff(user);
      if (params.res === "shipping") clearShippingCache();
      const r = RES[params.res]; if (!r || r.readOnly) throw notFound();
      const d = clean(r, await body(), false);
      if (r.created) d[r.created] = new Date().toISOString();
      if (r.updated) d[r.updated] = new Date().toISOString();
      try {
        const [row] = await sql`insert into ${sql(r.table)} ${sql(d)} returning *`;
        return json(rowOut(row), 201);
      } catch (e: any) {
        if (e.code === "23505") throw bad({ detail: "That already exists." });
        if (e.code === "23503") throw bad({ detail: "Linked record not found." });
        throw e;
      }
    },
  });

  route("/admin/r/:res/:id", {
    GET: async ({ user, params }) => {
      staff(user);
      const r = RES[params.res]; if (!r) throw notFound();
      const [row] = await sql`select * from ${sql(r.table)} where id = ${id(params.id)}`;
      if (!row) throw notFound();
      return json(rowOut(row));
    },
    PATCH: async ({ user, params, body }) => {
      staff(user);
      if (params.res === "shipping") clearShippingCache();
      const r = RES[params.res]; if (!r || r.readOnly) throw notFound();
      const d = clean(r, await body(), true);
      if (r.updated) d[r.updated] = new Date().toISOString();
      if (!Object.keys(d).length) throw bad({ detail: "Nothing to update" });
      try {
        const [row] = await sql`update ${sql(r.table)} set ${sql(d)} where id = ${id(params.id)} returning *`;
        if (!row) throw notFound();
        return json(rowOut(row));
      } catch (e: any) {
        if (e.code === "23505") throw bad({ detail: "That already exists." });
        throw e;
      }
    },
    DELETE: async ({ user, params }) => {
      staff(user);
      if (params.res === "shipping") clearShippingCache();
      const r = RES[params.res]; if (!r) throw notFound();
      const rid = id(params.id);
      await sql.begin(async (tx) => {
        if (params.res === "products") {
          const vs = await tx`select id from app_productvariant where product_id = ${rid}`;
          await deleteVariants(tx as any, vs.map((v: any) => v.id));
        } else if (params.res === "variants") {
          await deleteVariants(tx as any, [rid]);
          return;
        } else if (params.res === "categories") {
          const [{ n }] = await tx`select count(*)::int as n from app_product where category_id = ${rid}`;
          if (n) throw bad({ detail: `This category still has ${n} product(s). Move or delete them first.` });
        }
        await tx`delete from ${tx(r.table)} where id = ${rid}`;
      });
      return json(null, 204);
    },
  });

  // ---------------- orders
  route("/admin/orders", { GET: async ({ user, req }) => {
    staff(user);
    const q = new URL(req.url).searchParams;
    // Same as the Django admin: quietly check recent unpaid Razorpay orders before listing.
    const unpaid = await sql`select id, payment_status, transaction_id from app_order
                             where created_at > now() - interval '7 days' and payment_status = 'unpaid' and payment_method = 'razorpay' limit 10`;
    for (const o of unpaid) await syncOrderWithRazorpay(o as any).catch(() => {});
    const status = q.get("status"), pay = q.get("payment_status"), term = q.get("q")?.trim();
    const rows = await sql`
      select o.*, u.username, u.email,
        (select t.razorpay_order_id from app_paymenttransaction t where t.order_id = o.id order by t.created_at desc limit 1) as rzp_order_id,
        (select t.razorpay_payment_id from app_paymenttransaction t where t.order_id = o.id order by t.created_at desc limit 1) as rzp_payment_id,
        (select count(*)::int from app_orderitem oi where oi.order_id = o.id) as items_count,
        a.city as ship_city, a.postal_code as ship_pin
      from app_order o join auth_user u on u.id = o.user_id left join app_address a on a.id = o.shipping_address_id
      where true
        ${status ? sql`and o.status = ${status}` : sql``}
        ${pay ? sql`and o.payment_status = ${pay}` : sql``}
        ${term ? sql`and (o.id::text = ${term} or u.username ilike ${"%" + term + "%"} or u.email ilike ${"%" + term + "%"}
                     or o.transaction_id ilike ${"%" + term + "%"}
                     or exists (select 1 from app_paymenttransaction t where t.order_id = o.id and (t.razorpay_order_id ilike ${"%" + term + "%"} or t.razorpay_payment_id ilike ${"%" + term + "%"})))` : sql``}
      order by o.created_at desc limit 500`;
    return json(rows.map(rowOut));
  } });

  route("/admin/orders/:id", {
    GET: async ({ user, params }) => {
      staff(user);
      const [o] = await sql`select o.*, u.username, u.email, u.first_name, u.last_name from app_order o join auth_user u on u.id = o.user_id where o.id = ${id(params.id)}`;
      if (!o) throw notFound();
      const [full] = await ordersJson([o], false);
      const txs = await sql`select * from app_paymenttransaction where order_id = ${o.id} order by created_at desc`;
      return json({ ...full, customer: { id: o.user_id, username: o.username, email: o.email, name: `${o.first_name} ${o.last_name}`.trim() }, transactions: txs.map(rowOut) });
    },
    PATCH: async ({ user, params, body }) => {
      staff(user);
      const d = await body();
      const set: Record<string, any> = {};
      const STAT = ["pending", "confirmed", "processing", "shipped", "delivered", "cancelled", "refunded", "failed"];
      if (d.status !== undefined) { if (!STAT.includes(d.status)) throw bad({ detail: "Unknown status" }); set.status = d.status; }
      if (d.payment_status !== undefined) set.payment_status = String(d.payment_status).slice(0, 50);
      if (d.shipping_cost !== undefined) set.shipping_cost = money(paise(d.shipping_cost));
      if (d.transaction_id !== undefined) set.transaction_id = d.transaction_id || null;
      if (!Object.keys(set).length) throw bad({ detail: "Nothing to update" });
      set.updated_at = new Date().toISOString();
      const [before] = await sql`select status from app_order where id = ${id(params.id)}`;
      const [row] = await sql`update app_order set ${sql(set)} where id = ${id(params.id)} returning *`;
      if (!row) throw notFound();
      if (set.status && set.status !== before?.status) {
        await sql`insert into api_order_status_log (order_id, from_status, to_status, note, user_id)
                  values (${row.id}, ${before?.status ?? null}, ${set.status}, 'Changed in admin panel', ${user!.id})`;
      }
      if (set.status === "shipped" && before?.status !== "shipped") await whatsappShipped(row.id);
      return json(rowOut(row));
    },
  });

  route("/admin/orders/:id/sync", { POST: async ({ user, params }) => {
    staff(user);
    const [o] = await sql`select id, payment_status, transaction_id from app_order where id = ${id(params.id)}`;
    if (!o) throw notFound();
    const paid = await syncOrderWithRazorpay(o as any);
    return json({ paid, message: paid ? "Razorpay shows this order as paid — it is now Paid/Confirmed." : "Razorpay has no captured payment for this order." });
  } });

  route("/admin/orders/:id/resend-email", { POST: async ({ user, params }) => {
    staff(user);
    const r = await emailOrder(id(params.id));
    if (!r.ok) throw bad({ detail: `Email failed: ${r.error}` });
    return json({ message: "Confirmation email sent." });
  } });

  route("/admin/orders/:id/resend-whatsapp", { POST: async ({ user, params }) => {
    staff(user);
    if (!whatsappConfigured()) throw bad({ detail: "WhatsApp is not set up yet." });
    await whatsappOrder(id(params.id));
    return json({ message: "WhatsApp messages sent." });
  } });

  // ---------------- shop settings: free-shipping amount
  route("/admin/settings/free-shipping", {
    GET: async ({ user }) => {
      staff(user);
      const [r] = await sql`select value from app_shop_setting where key = 'free_shipping_above'`;
      return json({ free_above: Number(r?.value ?? 1000) });
    },
    PUT: async ({ user, body }) => {
      staff(user);
      const v = Number((await body()).free_above);
      if (!Number.isFinite(v) || v < 0 || v > 1_000_000) throw bad({ detail: "Enter an amount in rupees (0 = always free)." });
      await sql`insert into app_shop_setting (key, value) values ('free_shipping_above', ${String(v)})
                on conflict (key) do update set value = excluded.value`;
      clearShippingCache();
      return json({ free_above: v, message: "Saved" });
    },
  });

  // ---------------- notifications: status + test sends
  route("/admin/notifications", { GET: async ({ user }) => {
    staff(user);
    return json({
      email: emailStatus(),
      whatsapp: { configured: whatsappConfigured(), admin_numbers: adminNumbers(), templates: WA },
    });
  } });

  route("/admin/notifications/test-email", { POST: async ({ user, body }) => {
    staff(user);
    const d = await body();
    const to = String(d.to ?? "").trim();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(to)) throw bad({ detail: "Enter a valid email address." });
    const r = await sendTestEmail(to);
    return json({ ...r, message: r.ok ? `Test email sent to ${to}. Check the inbox (and spam folder).` : `Email failed: ${r.error}` });
  } });

  route("/admin/notifications/test-whatsapp", { POST: async ({ user, body }) => {
    staff(user);
    const d = await body();
    // Meta's ready-made "hello_world" template works before your own templates are approved.
    const template = String(d.template || "hello_world").trim();
    // Sample values so each of our templates can be tested on its own.
    const SAMPLES: Record<string, unknown[]> = {
      [WA.order]: ["Test Customer", "0000", "1.00", "Test product (100 ml) x1"],
      [WA.admin]: ["0000", "1.00", "Test Customer", "9999999999", "Kollam", "Test product (100 ml) x1"],
      [WA.shipped]: ["Test Customer", "0000"],
    };
    const params = Array.isArray(d.params) && d.params.length ? d.params : (SAMPLES[template] ?? []);
    // Meta's ready-made hello_world template exists only in US English.
    const r = await sendTemplate(String(d.to ?? ""), template, params, template === "hello_world" ? "en_US" : undefined);
    return json({ ...r, message: r.ok ? "WhatsApp message sent." : `WhatsApp failed: ${r.error}` });
  } });

  // ---------------- payment transactions / missed-order recovery
  route("/admin/transactions", { GET: async ({ user, req }) => {
    staff(user);
    const orphaned = new URL(req.url).searchParams.get("orphaned") === "1";
    const rows = await sql`select t.*, u.username, u.email from app_paymenttransaction t join auth_user u on u.id = t.user_id
                           where true ${orphaned ? sql`and t.order_id is null` : sql``} order by t.created_at desc limit 500`;
    return json(rows.map(rowOut));
  } });

  route("/admin/transactions/:id/recreate", { POST: async ({ user, params }) => {
    staff(user);
    const out = await sql.begin(async (tx) => {
      const [t] = await tx`select * from app_paymenttransaction where id = ${id(params.id)} for update`;
      if (!t) throw notFound();
      if (t.order_id) return { message: `Already linked to order #${t.order_id}.`, order_id: t.order_id };
      if (!["success", "created"].includes(t.status)) throw bad({ detail: `Transaction status is "${t.status}", nothing to recover.` });
      let [ship] = t.shipping_address_id ? await tx`select id from app_address where id = ${t.shipping_address_id} and user_id = ${t.user_id}` : [];
      if (!ship) [ship] = await tx`select id from app_address where user_id = ${t.user_id} order by is_default desc, id desc limit 1`;
      let [bill] = t.billing_address_id ? await tx`select id from app_address where id = ${t.billing_address_id} and user_id = ${t.user_id}` : [];
      bill ??= ship;
      let [o] = t.razorpay_payment_id ? await tx`select id from app_order where transaction_id = ${t.razorpay_payment_id} limit 1` : [];
      if (!o) {
        [o] = await tx`insert into app_order (total_amount, shipping_cost, status, payment_method, payment_status, transaction_id,
                         created_at, updated_at, billing_address_id, shipping_address_id, user_id)
                       values (${t.amount}, 0, 'confirmed', 'razorpay', ${t.status === "success" ? "paid" : "unpaid"},
                         ${t.razorpay_payment_id ?? t.razorpay_order_id}, now(), now(), ${bill?.id ?? null}, ${ship?.id ?? null}, ${t.user_id}) returning id`;
        const items = await tx`select ci.quantity, v.id as variant_id, v.price from app_cartitem ci join app_cart c on c.id = ci.cart_id
                               join app_productvariant v on v.id = ci.variant_id where c.user_id = ${t.user_id} order by ci.id`;
        for (const i of items) {
          await tx`insert into app_orderitem (quantity, unit_price, total_price, order_id, variant_id)
                   values (${i.quantity}, ${i.price}, ${money(i.quantity * paise(i.price))}, ${o.id}, ${i.variant_id})`;
        }
      }
      const status = t.status !== "success" && t.razorpay_payment_id ? "success" : t.status;
      await tx`update app_paymenttransaction set order_id = ${o.id}, status = ${status} where id = ${t.id}`;
      return { message: `Recovered as order #${o.id}.`, order_id: o.id };
    });
    return json(out);
  } });

  // ---------------- customers (read-only)
  route("/admin/users", { GET: async ({ user, req }) => {
    staff(user);
    const term = new URL(req.url).searchParams.get("q")?.trim();
    const rows = await sql`select u.id, u.username, u.email, u.first_name, u.last_name, u.is_staff, u.is_active, u.date_joined, u.last_login,
                             (select count(*)::int from app_order o where o.user_id = u.id and o.payment_status = 'paid') as paid_orders
                           from auth_user u where true
                           ${term ? sql`and (u.username ilike ${"%" + term + "%"} or u.email ilike ${"%" + term + "%"})` : sql``}
                           order by u.date_joined desc limit 1000`;
    return json(rows.map((r: any) => ({ ...r, date_joined: iso(r.date_joined), last_login: iso(r.last_login) })));
  } });

  route("/admin/image-url", { GET: ({ user, req }) => {
    staff(user);
    return json({ url: img(new URL(req.url).searchParams.get("name")) });
  } });
}
