// Shop serializers + Razorpay order/payment logic (ported from app/views.py & serializers.py).
import { sql, iso, money, paise } from "./db.ts";
import { background, img } from "./util.ts";
import { sendOrderSuccessEmail } from "./email.ts";
import { adminNumbers, sendTemplate, WA, whatsappConfigured } from "./whatsapp.ts";

// ------------------------------------------------------------------ Razorpay REST client
const RZP_ID = Deno.env.get("RAZORPAY_KEY_ID") ?? "";
const RZP_SECRET = Deno.env.get("RAZORPAY_KEY_SECRET") ?? "";
const RZP_BASE = Deno.env.get("RAZORPAY_API_BASE") ?? "https://api.razorpay.com/v1";
export const razorpayKeyId = () => RZP_ID;

export async function rzp(path: string, body?: unknown) {
  const r = await fetch(RZP_BASE + path, {
    method: body ? "POST" : "GET",
    headers: { "Authorization": "Basic " + btoa(`${RZP_ID}:${RZP_SECRET}`), "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data?.error?.description ?? `Razorpay HTTP ${r.status}`);
  return data;
}

async function hmacHex(secret: string, msg: string | Uint8Array) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = await crypto.subtle.sign("HMAC", key, (typeof msg === "string" ? new TextEncoder().encode(msg) : msg) as BufferSource);
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function eq(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
/** razorpay client.utility.verify_payment_signature */
export async function verifyPaymentSignature(orderId: string, paymentId: string, signature: string) {
  return eq(await hmacHex(RZP_SECRET, `${orderId}|${paymentId}`), String(signature));
}
export async function verifyWebhookSignature(secret: string, raw: Uint8Array, signature: string) {
  return eq(await hmacHex(secret, raw), String(signature));
}

// ------------------------------------------------------------------ serializers
const productMini = (p: any) => ({ id: p.product_id, title: p.title, brand: p.brand, image1: img(p.image1) });

/** ProductVariantSerializer */
export const variantJson = (v: any) => ({
  id: v.id, quantity_label: v.quantity_label, mrp: v.mrp, price: v.price, stock: v.stock, sku: v.sku,
  product: productMini(v),
});

export async function variantsByProduct(productIds: number[]) {
  if (!productIds.length) return new Map<number, any[]>();
  const rows = await sql`
    select v.id, v.quantity_label, v.mrp, v.price, v.stock, v.sku, v.product_id, p.title, p.brand, p.image1
    from app_productvariant v join app_product p on p.id = v.product_id
    where v.product_id in ${sql(productIds)} order by v.id`;
  const m = new Map<number, any[]>();
  for (const r of rows) {
    if (!m.has(r.product_id)) m.set(r.product_id, []);
    m.get(r.product_id)!.push(variantJson(r));
  }
  return m;
}

/** ProductListSerializer / ProductDetailSerializer */
export function productJson(p: any, variants: any[], detail = false) {
  const o: any = {
    id: p.id, title: p.title, brand: p.brand,
    image1: img(p.image1), image2: img(p.image2), image3: img(p.image3), image4: img(p.image4),
    category: { id: p.category_id, name: p.category_name },
    category_name: p.category_name,
    variants,
  };
  if (detail) o.description = p.description;
  return o;
}

/** AddressSerializer */
export const addressJson = (a: any) => a ? ({
  id: a.id, label: a.label, line1: a.line1, line2: a.line2, city: a.city, state: a.state,
  postal_code: a.postal_code, country: a.country, phone: a.phone, is_default: a.is_default,
}) : null;

/** Line items (cart / wishlist / order) with variant + product info. */
const LINE_SELECT = sql`
  v.id as v_id, v.quantity_label, v.mrp, v.price, v.stock, v.sku, v.product_id, p.title, p.brand, p.image1`;
const lineVariant = (r: any) => variantJson({ ...r, id: r.v_id });

export async function cartJson(userId: number) {
  let [cart] = await sql`select id from app_cart where user_id = ${userId}`;
  if (!cart) [cart] = await sql`insert into app_cart (created_at, user_id) values (now(), ${userId})
                                 on conflict (user_id) do update set user_id = excluded.user_id returning id`;
  const rows = await sql`
    select ci.id, ci.quantity, ${LINE_SELECT}
    from app_cartitem ci join app_productvariant v on v.id = ci.variant_id join app_product p on p.id = v.product_id
    where ci.cart_id = ${cart.id} order by ci.id`;
  let total = 0;
  const items = rows.map((r) => {
    const line = r.quantity * paise(r.price);
    total += line;
    return {
      id: r.id, variant: lineVariant(r), product_title: r.title, product_brand: r.brand,
      product_image: img(r.image1), quantity: r.quantity, total_price: line / 100,
    };
  });
  return { id: cart.id, items, cart_total: total / 100 };
}

export async function wishlistId(userId: number): Promise<number> {
  const [w] = await sql`insert into app_wishlist (created_at, user_id) values (now(), ${userId})
                        on conflict (user_id) do update set user_id = excluded.user_id returning id`;
  return w.id;
}

export async function wishlistJson(userId: number) {
  const id = await wishlistId(userId);
  const rows = await sql`
    select wi.id, ${LINE_SELECT}
    from app_wishlistitem wi join app_productvariant v on v.id = wi.variant_id join app_product p on p.id = v.product_id
    where wi.wishlist_id = ${id} order by wi.id`;
  return {
    id,
    items: rows.map((r) => ({
      id: r.id, variant: lineVariant(r), product_title: r.title, product_brand: r.brand, product_image: img(r.image1),
    })),
  };
}

/** OrderSerializer (detail) / OrderListSerializer (list) */
export async function ordersJson(orders: any[], list: boolean) {
  if (!orders.length) return [];
  const ids = orders.map((o) => o.id);
  const addrIds = [...new Set(orders.flatMap((o) => [o.shipping_address_id, o.billing_address_id]).filter(Boolean))];
  const [items, addrs, txs] = await Promise.all([
    sql`select oi.id, oi.order_id, oi.quantity, oi.unit_price, oi.total_price, ${LINE_SELECT}
        from app_orderitem oi join app_productvariant v on v.id = oi.variant_id join app_product p on p.id = v.product_id
        where oi.order_id in ${sql(ids)} order by oi.id`,
    addrIds.length ? sql`select * from app_address where id in ${sql(addrIds)}` : Promise.resolve([] as any[]),
    sql`select distinct on (order_id) order_id, razorpay_order_id, razorpay_payment_id
        from app_paymenttransaction where order_id in ${sql(ids)} order by order_id, created_at desc`,
  ]);
  const addrMap = new Map(addrs.map((a: any) => [a.id, addressJson(a)]));
  const txMap = new Map(txs.map((t: any) => [t.order_id, t]));
  const itemsBy = new Map<number, any[]>();
  for (const r of items) {
    if (!itemsBy.has(r.order_id)) itemsBy.set(r.order_id, []);
    itemsBy.get(r.order_id)!.push({
      id: r.id, variant: lineVariant(r), product_title: r.title, product_brand: r.brand, product_image: img(r.image1),
      quantity: r.quantity, unit_price: r.unit_price, total_price: r.total_price,
      _image1: r.image1,
    });
  }
  return orders.map((o) => {
    const its = itemsBy.get(o.id) ?? [];
    const tx = txMap.get(o.id);
    const base: any = {
      id: o.id,
      items: its.map(({ _image1, ...rest }) => rest),
      shipping_address: addrMap.get(o.shipping_address_id) ?? null,
      billing_address: addrMap.get(o.billing_address_id) ?? null,
      razorpay_order_id: tx?.razorpay_order_id ?? null,
      razorpay_payment_id: tx?.razorpay_payment_id ?? null,
      total_amount: o.total_amount, status: o.status, payment_status: o.payment_status,
      payment_method: o.payment_method, transaction_id: o.transaction_id,
      created_at: iso(o.created_at), updated_at: iso(o.updated_at),
    };
    if (list) {
      base.first_product_image = its[0] ? img(its[0]._image1) : null;
      base.first_product_title = its[0]?.product_title ?? null;
      base.items_count = its.length;
    } else {
      base.shipping_cost = o.shipping_cost;
      base.user = o.user_id;
    }
    return base;
  });
}

// ------------------------------------------------------------------ payment completion (shared by verify / webhook / sync / admin)
type OrderRow = { id: number; user_id: number };

/** Load what the confirmation email needs, then send it (never throws). */
export async function emailOrder(orderId: number): Promise<{ ok: boolean; error?: string }> {
  try {
    const [o] = await sql`select o.*, u.username, u.email, u.first_name, u.last_name from app_order o
                          join auth_user u on u.id = o.user_id where o.id = ${orderId}`;
    if (!o) return { ok: false, error: "Order not found" };
    const [addr] = o.shipping_address_id ? await sql`select * from app_address where id = ${o.shipping_address_id}` : [null];
    const items = await sql`select p.title, v.quantity_label, oi.quantity, oi.total_price from app_orderitem oi
                            join app_productvariant v on v.id = oi.variant_id join app_product p on p.id = v.product_id
                            where oi.order_id = ${orderId} order by oi.id`;
    return await sendOrderSuccessEmail(o as any, o as any, addr, items as any);
  } catch (e) {
    console.error(`Order confirmation email failed for order #${orderId}:`, e);
    return { ok: false, error: String(e) };
  }
}

async function orderForMessages(orderId: number) {
  const [o] = await sql`select o.*, u.username, u.email, u.first_name, u.last_name from app_order o
                        join auth_user u on u.id = o.user_id where o.id = ${orderId}`;
  if (!o) return null;
  const [addr] = o.shipping_address_id ? await sql`select * from app_address where id = ${o.shipping_address_id}` : [null];
  const items = await sql`select p.title, v.quantity_label, oi.quantity from app_orderitem oi
                          join app_productvariant v on v.id = oi.variant_id join app_product p on p.id = v.product_id
                          where oi.order_id = ${orderId} order by oi.id`;
  const name = (`${o.first_name ?? ""} ${o.last_name ?? ""}`.trim() || o.username) as string;
  const summary = items.map((i: any) => `${i.title} (${i.quantity_label}) x${i.quantity}`).join(", ");
  const amount = Number(o.total_amount).toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return { o, addr, name, summary, amount, phone: addr?.phone as string | undefined, city: (addr?.city ?? "") as string };
}

/** WhatsApp the customer and the shop staff about a newly paid order (never throws). */
export async function whatsappOrder(orderId: number) {
  if (!whatsappConfigured()) return;
  try {
    const m = await orderForMessages(orderId);
    if (!m) return;
    await Promise.all([
      // Customer: Hi {{1}}, your Jaji's order #{{2}} of Rs {{3}} is confirmed. Items: {{4}}
      m.phone ? sendTemplate(m.phone, WA.order, [m.name, m.o.id, m.amount, m.summary]) : null,
      // Staff: New order #{{1}} - Rs {{2}} from {{3}} ({{4}}, {{5}}). Items: {{6}}
      ...adminNumbers().map((n) => sendTemplate(n, WA.admin, [m.o.id, m.amount, m.name, m.phone ?? "-", m.city || "-", m.summary])),
    ]);
  } catch (e) {
    console.error(`WhatsApp alert failed for order #${orderId}:`, e);
  }
}

/** WhatsApp the customer that the order has shipped (never throws). */
export async function whatsappShipped(orderId: number) {
  if (!whatsappConfigured()) return;
  try {
    const m = await orderForMessages(orderId);
    // Hi {{1}}, your Jaji's order #{{2}} has been shipped.
    if (m?.phone) await sendTemplate(m.phone, WA.shipped, [m.name, m.o.id]);
  } catch (e) {
    console.error(`WhatsApp shipped message failed for order #${orderId}:`, e);
  }
}

/** Everything that should happen once an order becomes paid. */
export async function notifyOrder(orderId: number) {
  await Promise.all([emailOrder(orderId), whatsappOrder(orderId)]);
}

/**
 * Mark an existing order paid exactly once: status/payment, stock deduction, clear cart,
 * update the payment transaction. Returns true if this call did the update.
 */
export async function markOrderPaid(
  tx: typeof sql, orderId: number, paymentId: string, rzpOrderId: string | null, signature?: string | null,
): Promise<boolean> {
  const [o] = await tx`select id, user_id, payment_status from app_order where id = ${orderId} for update`;
  if (!o || o.payment_status === "paid") return false;
  await tx`update app_order set status = 'confirmed', payment_status = 'paid', transaction_id = ${paymentId},
           updated_at = now() where id = ${orderId}`;
  await tx`update app_productvariant v set stock = greatest(0, v.stock - oi.quantity)
           from app_orderitem oi where oi.order_id = ${orderId} and oi.variant_id = v.id`;
  await tx`delete from app_cartitem where cart_id in (select id from app_cart where user_id = ${o.user_id})`;
  if (rzpOrderId) {
    await tx`update app_paymenttransaction set status = 'success', razorpay_payment_id = ${paymentId},
             razorpay_signature = coalesce(${signature ?? null}, razorpay_signature), order_id = ${orderId}
             where id = (select id from app_paymenttransaction where razorpay_order_id = ${rzpOrderId} order by id limit 1)`;
  }
  return true;
}

/** sync_order_razorpay_status: ask Razorpay whether an unpaid order was actually paid. */
export async function syncOrderWithRazorpay(order: { id: number; payment_status: string; transaction_id: string | null }) {
  if (order.payment_status === "paid") return true;
  let rzpOrderId: string | null = null;
  if (order.transaction_id?.startsWith("order_")) rzpOrderId = order.transaction_id;
  else {
    const [t] = await sql`select razorpay_order_id from app_paymenttransaction where order_id = ${order.id} order by id limit 1`;
    rzpOrderId = t?.razorpay_order_id ?? null;
  }
  if (!rzpOrderId) return false;
  try {
    const data = await rzp(`/orders/${rzpOrderId}/payments`);
    for (const p of data.items ?? []) {
      if (p.status === "captured" || p.captured === true) {
        const done = await sql.begin((tx) => markOrderPaid(tx as any, order.id, p.id, rzpOrderId));
        if (done) background(notifyOrder(order.id));
        return true;
      }
    }
  } catch (e) {
    console.warn(`Error checking Razorpay for order #${order.id}:`, e);
  }
  return false;
}

export { money, paise };

// ------------------------------------------------------------------ shipping (per order, by destination)
type Rate = { state: string; district: string | null; amount: string };
let rulesCache: { at: number; rates: Rate[]; freeAbove: number } | null = null;

/** Shipping rates + free-shipping threshold (cached for 60 s; admin edits clear it). */
export async function shippingRules() {
  if (rulesCache && Date.now() - rulesCache.at < 60_000) return rulesCache;
  const [rates, [s]] = await Promise.all([
    sql`select state, district, amount from app_shipping_rate order by state, district nulls first`,
    sql`select value from app_shop_setting where key = 'free_shipping_above'`,
  ]);
  const freeAbove = Number(s?.value ?? 1000);
  rulesCache = { at: Date.now(), rates: rates as any, freeAbove: Number.isFinite(freeAbove) ? freeAbove : 1000 };
  return rulesCache;
}
export const clearShippingCache = () => { rulesCache = null; };

const norm = (v: unknown) => String(v ?? "").trim().toLowerCase();

/**
 * One charge per order: district rate, else state rate, else the "All India" rate.
 * Free when the items total reaches the free-shipping amount. Works in paise.
 */
export async function shippingFor(state: unknown, district: unknown, subtotalPaise: number) {
  const { rates, freeAbove } = await shippingRules();
  if (subtotalPaise >= Math.round(freeAbove * 100)) return 0;
  const st = norm(state), di = norm(district);
  const hit = rates.find((r) => norm(r.state) === st && r.district && norm(r.district) === di)
    ?? rates.find((r) => norm(r.state) === st && !r.district)
    ?? rates.find((r) => norm(r.state) === "all india" && !r.district);
  return hit ? paise(hit.amount) : 0;
}
