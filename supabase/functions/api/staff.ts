// Order desk for shop staff (staff.html in the admin site).
// Order-desk accounts (api_order_staff) can ONLY list paid orders, open one, and move its status along.
// Admin accounts (is_staff) can use it too. Every status change is logged with who did it.
import { sql, iso } from "./db.ts";
import { bad, checkPassword, HttpError, json, makePassword, newTokenKey, notFound, type User } from "./util.ts";
import { whatsappShipped } from "./shop.ts";

type Ctx = { req: Request; user: User | null; params: Record<string, string>; body: () => Promise<Record<string, any>> };
type RouteFn = (path: string, methods: Record<string, (c: Ctx) => Promise<Response> | Response>, opts?: { noAuth?: boolean }) => void;

const DESK_STATUSES = ["confirmed", "processing", "shipped", "delivered"] as const;
const LABEL: Record<string, string> = { confirmed: "New", processing: "Packing", shipped: "Shipped", delivered: "Delivered" };

async function isDeskUser(u: User) {
  if (u.is_staff) return true;
  const [r] = await sql`select 1 from api_order_staff where user_id = ${u.id}`;
  return Boolean(r);
}
async function desk(u: User | null): Promise<User> {
  if (!u) throw new HttpError(401, { detail: "Please log in." });
  if (!(await isDeskUser(u))) throw new HttpError(403, { detail: "This account can't use the order desk." });
  return u;
}
function adminOnly(u: User | null): User {
  if (!u) throw new HttpError(401, { detail: "Please log in." });
  if (!u.is_staff) throw new HttpError(403, { detail: "Only admins can manage staff logins." });
  return u;
}
const num = (v: string) => { if (!/^\d+$/.test(v)) throw notFound(); return Number(v); };
const name = (o: any) => `${o.first_name ?? ""} ${o.last_name ?? ""}`.trim() || o.username;
const USERNAME_RE = /^[\w.@+-]{3,150}$/;

export function staffRoutes(route: RouteFn) {
  route("/staff/login", { POST: async ({ body }) => {
    const d = await body();
    const [u] = await sql`select id, password, is_active, is_staff, username from auth_user where username = ${String(d.username ?? "").trim()}`;
    if (!u || !u.is_active || !(await checkPassword(String(d.password ?? ""), u.password))) throw bad({ detail: "Wrong username or password." });
    if (!(await isDeskUser(u as any))) throw new HttpError(403, { detail: "This account can't use the order desk." });
    const [t] = await sql`insert into authtoken_token (key, created, user_id) values (${newTokenKey()}, now(), ${u.id})
                          on conflict (user_id) do update set user_id = excluded.user_id returning key`;
    await sql`update auth_user set last_login = now() where id = ${u.id}`;
    return json({ token: t.key, username: u.username });
  } });

  route("/staff/me", { GET: async ({ user }) => {
    const u = await desk(user);
    return json({ username: u.username, is_admin: u.is_staff });
  } });

  // Paid orders only. view: todo (New + Packing), shipped, delivered, all
  route("/staff/orders", { GET: async ({ user, req }) => {
    await desk(user);
    const q = new URL(req.url).searchParams;
    const view = q.get("view") ?? "todo";
    const term = q.get("q")?.trim() ?? "";
    const statuses = view === "todo" ? ["confirmed", "processing"] : view === "shipped" ? ["shipped"]
      : view === "delivered" ? ["delivered"] : [...DESK_STATUSES, "cancelled", "refunded"];
    const digits = term.replace(/\D/g, "");
    const rows = await sql`
      select o.id, o.status, o.total_amount, o.shipping_cost, o.created_at, o.updated_at,
             u.username, u.first_name, u.last_name, a.phone, a.city, a.state,
             (select coalesce(sum(oi.quantity),0)::int from app_orderitem oi where oi.order_id = o.id) as pieces
      from app_order o join auth_user u on u.id = o.user_id left join app_address a on a.id = o.shipping_address_id
      where o.payment_status = 'paid' and o.status in ${sql(statuses)}
        ${term ? sql`and (o.id::text = ${term} or u.first_name ilike ${"%" + term + "%"} or u.last_name ilike ${"%" + term + "%"}
                     or u.email ilike ${"%" + term + "%"} ${digits.length >= 4 ? sql`or a.phone like ${"%" + digits + "%"}` : sql``})` : sql``}
      order by ${view === "todo" ? sql`o.created_at asc` : sql`o.updated_at desc`} limit 300`;
    const [counts] = await sql`select count(*) filter (where status = 'confirmed')::int as new,
                                      count(*) filter (where status = 'processing')::int as packing,
                                      count(*) filter (where status = 'shipped')::int as shipped
                               from app_order where payment_status = 'paid'`;
    return json({
      counts,
      orders: rows.map((o: any) => ({
        id: o.id, status: o.status, status_label: LABEL[o.status] ?? o.status, total: o.total_amount,
        customer: name(o), phone: o.phone, place: [o.city, o.state].filter(Boolean).join(", "), pieces: o.pieces,
        created_at: iso(o.created_at), updated_at: iso(o.updated_at),
      })),
    });
  } });

  route("/staff/orders/:id", { GET: async ({ user, params }) => {
    await desk(user);
    const [o] = await sql`select o.*, u.username, u.first_name, u.last_name, u.email from app_order o join auth_user u on u.id = o.user_id
                          where o.id = ${num(params.id)} and o.payment_status = 'paid'`;
    if (!o) throw notFound("Order not found (or not paid yet).");
    const [a] = o.shipping_address_id ? await sql`select * from app_address where id = ${o.shipping_address_id}` : [null];
    const items = await sql`select p.title, v.quantity_label, v.sku, oi.quantity, oi.total_price from app_orderitem oi
                            join app_productvariant v on v.id = oi.variant_id join app_product p on p.id = v.product_id
                            where oi.order_id = ${o.id} order by oi.id`;
    const log = await sql`select l.from_status, l.to_status, l.note, l.at, u.username from api_order_status_log l
                          left join auth_user u on u.id = l.user_id where l.order_id = ${o.id} order by l.at desc limit 50`;
    return json({
      id: o.id, status: o.status, status_label: LABEL[o.status] ?? o.status,
      total: o.total_amount, shipping_cost: o.shipping_cost, payment_id: o.transaction_id,
      created_at: iso(o.created_at), updated_at: iso(o.updated_at),
      customer: { name: name(o), email: o.email, guest: String(o.username).startsWith("guest_") },
      address: a ? { line1: a.line1, line2: a.line2, city: a.city, state: a.state, postal_code: a.postal_code, phone: a.phone } : null,
      items: items.map((i: any) => ({ title: i.title, variant: i.quantity_label, sku: i.sku, quantity: i.quantity, total: i.total_price })),
      history: log.map((l: any) => ({ from: LABEL[l.from_status] ?? l.from_status, to: LABEL[l.to_status] ?? l.to_status, note: l.note, by: l.username, at: iso(l.at) })),
    });
  } });

  // Move an order along: New → Packing → Shipped → Delivered (going back one step is allowed to fix mistakes).
  route("/staff/orders/:id/status", { POST: async ({ user, params, body }) => {
    const u = await desk(user);
    const d = await body();
    const to = String(d.status ?? "");
    if (!(DESK_STATUSES as readonly string[]).includes(to)) throw bad({ detail: "Unknown status." });
    const note = String(d.note ?? "").trim().slice(0, 500) || null;
    const res = await sql.begin(async (tx) => {
      const [o] = await tx`select id, status from app_order where id = ${num(params.id)} and payment_status = 'paid' for update`;
      if (!o) throw notFound("Order not found (or not paid yet).");
      if (o.status === to) return { changed: false, from: o.status };
      if (!(DESK_STATUSES as readonly string[]).includes(o.status)) {
        throw bad({ detail: `This order is ${o.status}; only an admin can change it.` });
      }
      await tx`update app_order set status = ${to}, updated_at = now() where id = ${o.id}`;
      await tx`insert into api_order_status_log (order_id, from_status, to_status, note, user_id) values (${o.id}, ${o.status}, ${to}, ${note}, ${u.id})`;
      return { changed: true, from: o.status };
    });
    if (res.changed && to === "shipped") await whatsappShipped(num(params.id));
    return json({ message: res.changed ? `Order #${params.id} is now ${LABEL[to]}.` : `Order #${params.id} was already ${LABEL[to]}.`, status: to });
  } });

  // ---------------- admin: manage order-desk logins
  route("/admin/order-staff", {
    GET: async ({ user }) => {
      adminOnly(user);
      const rows = await sql`select u.id, u.username, u.first_name, u.is_active, u.last_login, s.created_at,
                               (select count(*)::int from api_order_status_log l where l.user_id = u.id) as updates
                             from api_order_staff s join auth_user u on u.id = s.user_id order by s.created_at desc`;
      return json(rows.map((r: any) => ({ ...r, last_login: iso(r.last_login), created_at: iso(r.created_at) })));
    },
    POST: async ({ user, body }) => {
      const me = adminOnly(user);
      const d = await body();
      const username = String(d.username ?? "").trim();
      const password = String(d.password ?? "");
      const first = String(d.name ?? "").trim().slice(0, 150);
      if (!USERNAME_RE.test(username) || username.toLowerCase().startsWith("guest_")) throw bad({ detail: "Username: 3+ letters/numbers, no spaces." });
      if (password.length < 8) throw bad({ detail: "Password must be at least 8 characters." });
      if ((await sql`select 1 from auth_user where username = ${username}`).length) throw bad({ detail: "That username is taken." });
      const hash = await makePassword(password);
      await sql.begin(async (tx) => {
        const [u] = await tx`insert into auth_user (password, is_superuser, username, first_name, last_name, email, is_staff, is_active, date_joined)
                             values (${hash}, false, ${username}, ${first}, '', '', false, true, now()) returning id`;
        await tx`insert into api_order_staff (user_id, created_by) values (${u.id}, ${me.id})`;
      });
      return json({ message: `Staff login "${username}" created.` }, 201);
    },
  });

  route("/admin/order-staff/:id", {
    PATCH: async ({ user, params, body }) => {
      adminOnly(user);
      const d = await body();
      const uid = num(params.id);
      const [s] = await sql`select 1 from api_order_staff where user_id = ${uid}`;
      if (!s) throw notFound();
      if (d.password !== undefined) {
        if (String(d.password).length < 8) throw bad({ detail: "Password must be at least 8 characters." });
        await sql`update auth_user set password = ${await makePassword(String(d.password))} where id = ${uid}`;
        await sql`delete from authtoken_token where user_id = ${uid}`; // signs them out everywhere
      }
      if (d.is_active !== undefined) {
        await sql`update auth_user set is_active = ${Boolean(d.is_active)} where id = ${uid}`;
        if (!d.is_active) await sql`delete from authtoken_token where user_id = ${uid}`;
      }
      return json({ message: "Saved." });
    },
  });
}
