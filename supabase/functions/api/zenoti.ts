// Salon appointment booking on the website, through Zenoti.
// The website never sees the Zenoti key: it talks to these routes, which call https://api.zenoti.com.
//
// Flow (all public, no website login needed):
//   GET  /booking/status                       -> { configured }
//   GET  /booking/centers                      -> salons that take online bookings
//   GET  /booking/centers/:id/services         -> services, grouped by category
//   POST /booking/start   {center_id, service_id, date, first_name, last_name, phone, email, therapist_gender}
//                                              -> finds/creates the guest in Zenoti, opens a Zenoti booking,
//                                                 returns our ref + free slots for that date
//   POST /booking/:ref/date {date}             -> slots for another date (same guest/service)
//   POST /booking/:ref/confirm {slot_time, notes} -> reserves + confirms the slot; returns the appointment
//
// Each booking attempt is kept in api_zenoti_booking so admins can see what came in from the website.
import { sql, iso } from "./db.ts";
import { bad, EMAIL_RE, HttpError, json, notFound, type User } from "./util.ts";
import { normalisePhone } from "./whatsapp.ts";

type Ctx = { req: Request; user: User | null; params: Record<string, string>; body: () => Promise<Record<string, any>> };
type RouteFn = (path: string, methods: Record<string, (c: Ctx) => Promise<Response> | Response>, opts?: { noAuth?: boolean }) => void;

const BASE = (Deno.env.get("ZENOTI_API_URL") ?? "https://api.zenoti.com").replace(/\/$/, "");
const KEY = () => Deno.env.get("ZENOTI_API_KEY") ?? "";
// Optional: limit the website to some centers (comma-separated Zenoti center ids).
const ONLY_CENTERS = () => (Deno.env.get("ZENOTI_CENTER_IDS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
export const zenotiConfigured = () => Boolean(KEY());

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9-]{8,64}$/;
const SLOT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/;

class ZenotiError extends Error {
  constructor(public status: number, public detail: string, public raw: unknown) { super(detail); }
}

async function z(method: string, path: string, body?: unknown): Promise<any> {
  if (!zenotiConfigured()) throw new HttpError(503, { detail: "Online booking is not switched on yet. Please call the salon to book." });
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 15000);
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: { Authorization: `apikey ${KEY()}`, "Content-Type": "application/json", Accept: "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: ctl.signal,
    });
  } catch (e) {
    console.error("zenoti network", method, path, String(e));
    throw new HttpError(502, { detail: "The booking system is not responding. Please try again in a minute." });
  } finally { clearTimeout(timer); }
  const text = await res.text();
  let data: any = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = (data && (data.message || data.Message || data.error?.message || data.error_description || data.Error)) || `HTTP ${res.status}`;
    console.error("zenoti error", method, path, res.status, typeof data === "string" ? data.slice(0, 500) : JSON.stringify(data).slice(0, 500));
    throw new ZenotiError(res.status, String(msg), data);
  }
  return data;
}

/** Turn a Zenoti failure into something a customer can read. Never leak the raw message for auth problems. */
function friendly(e: unknown, fallback: string): never {
  if (e instanceof HttpError) throw e;
  if (e instanceof ZenotiError) {
    if (e.status === 401 || e.status === 403) throw new HttpError(503, { detail: "Online booking is temporarily unavailable. Please call the salon to book." });
    throw new HttpError(400, { detail: `${fallback} ${e.detail}`.trim() });
  }
  console.error(e);
  throw new HttpError(500, { detail: fallback });
}

// ---------------------------------------------------------------- small cache (per warm instance)
const cache = new Map<string, { at: number; v: any }>();
async function cached<T>(key: string, ms: number, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ms) return hit.v;
  const v = await fn();
  cache.set(key, { at: Date.now(), v });
  return v;
}

// ---------------------------------------------------------------- catalogue
// Zenoti names are typed in by staff ("JAJIS INNOVATION PVT LTD PARAVUR", "HAIR CUT(gents)"): make them readable.
const SMALL = new Set(["and", "or", "of", "for", "with", "the", "in", "on", "to", "a"]);
const KEEP = new Set(["DIY", "UV", "SPF", "BB", "CC", "TVM", "RP", "O3+", "VLCC", "PRP", "HD", "3D", "K18", "KSRTC", "MG", "NH"]);
export function prettyName(raw: string): string {
  let s = String(raw ?? "").replace(/\s+/g, " ").replace(/\s*\(\s*/g, " (").replace(/\s*\)/g, ")").replace(/\s*,\s*/g, ", ").trim();
  const letters = s.replace(/[^A-Za-z]/g, "");
  const shouty = letters.length > 0 && letters.replace(/[^A-Z]/g, "").length / letters.length > 0.6;
  if (!shouty) return s.charAt(0).toUpperCase() + s.slice(1);
  return s.toLowerCase().split(" ").map((w, i) => {
    const up = w.toUpperCase();
    if (KEEP.has(up.replace(/[(),]/g, ""))) return up;
    if (i > 0 && SMALL.has(w)) return w;
    return w.replace(/^([(]?)([a-z])/, (_, p, c) => p + c.toUpperCase());
  }).join(" ");
}

const CATEGORY_RULES: [RegExp, string][] = [
  [/bridal|bride|wedding|engagement|reception|saree draping|party make ?up|make ?up/i, "Bridal & makeup"],
  [/hair ?cut|haircut|trim|fringe|styling|blow ?dry|iron|curl|crimp|updo|bun|braid/i, "Haircuts & styling"],
  [/colou?r|highlight|balayage|ombre|global|root touch|henna|mehendi|grey/i, "Hair colour"],
  [/keratin|smooth|straighten|rebond|botox|nanoplast|cysteine|perm|treatment|spa|scalp|dandruff|hair fall|olaplex|k18/i, "Hair treatments & spa"],
  [/facial|clean ?up|peel|glow|skin|detan|de-tan|bleach|hydra|acne|pigment|wrinkle|charcoal|derma/i, "Facials & skin"],
  [/wax|thread|eyebrow|upper lip|chin|forehead|full face|under ?arm|epil/i, "Waxing & threading"],
  [/mani|pedi|nail|gel polish|extension/i, "Hands, feet & nails"],
  [/massage|body|polish|scrub|head massage|back|foot reflex|potli/i, "Massage & body"],
  [/shave|beard|moustache|men|gents/i, "Men's grooming"],
];
function guessCategory(name: string) {
  for (const [re, cat] of CATEGORY_RULES) if (re.test(name)) return cat;
  return "Other services";
}
const ORDER = CATEGORY_RULES.map(([, c]) => c);
const catOrder = (c: string) => { const i = ORDER.indexOf(c); return i < 0 ? 99 : i; };

// Friendly salon names. Matches the place words in Zenoti's center name / code / city.
const PLACES: [RegExp, string][] = [
  [/\brp\b|rp ?mall|jirp/i, "RP Mall, Kollam"],
  [/knply|karunagap|jikp/i, "Karunagappally"],
  [/pltd|polayath/i, "Polayathodu, Kollam"],
  [/sasthamcott|sasthamkott/i, "Sasthamcotta"],
  [/paravur|paravoor/i, "Paravur"],
  [/\btvm\b|thiruvanan|trivandrum|vazhuthac/i, "Vazhuthacaud, Thiruvananthapuram"],
  [/tripuni|thripuni/i, "Tripunithura"],
];
function centerName(c: any, city: string | null) {
  const hay = `${c.display_name ?? ""} ${c.name ?? ""} ${c.code ?? ""} ${city ?? ""}`;
  for (const [re, place] of PLACES) if (re.test(hay)) return `Jaji's ${place}`;
  const rest = String(pick(c.display_name, c.name) ?? "").replace(/jaji'?s?\s*(inno\w*)?\s*(pvt\.?\s*ltd\.?)?/i, "").trim();
  return `Jaji's ${prettyName(rest || city || "salon")}`;
}
const HIDDEN_CENTER = /warehouse|store ?room|head ?office|\btest\b|training/i;
const pick = (...vals: any[]) => vals.find((v) => v !== undefined && v !== null && v !== "");

async function centers() {
  return cached("centers", 10 * 60_000, async () => {
    const d = await z("GET", "/v1/centers?expand=working_hours");
    const list: any[] = d?.centers ?? d?.Centers ?? [];
    const only = ONLY_CENTERS();
    return list
      .filter((c) => !only.length || only.includes(c.id))
      .filter((c) => c.online_booking_enabled !== false && c.is_active !== false)
      .filter((c) => !HIDDEN_CENTER.test(`${c.name ?? ""} ${c.display_name ?? ""}`))
      .map((c) => {
        const a = c.address_info ?? c.address ?? {};
        const city = pick(a.city, c.city) ?? null;
        return {
          id: c.id,
          name: centerName(c, city),
          city: city ? prettyName(city) : null,
          address: prettyName([a.address_1, a.address_2].filter(Boolean).join(", ")) || null,
          phone: pick(c.contact_info?.phone_1?.number, c.contact_info?.phone?.number, c.phone) ?? null,
          country_id: pick(a.country_id, c.country?.id, c.country_id) ?? null,
        };
      })
      .sort((x, y) => x.name.localeCompare(y.name));
  });
}

async function services(centerId: string) {
  return cached(`services:${centerId}`, 10 * 60_000, async () => {
    const out: any[] = [];
    for (let page = 1; page <= 10; page++) {
      const d = await z("GET", `/v1/Centers/${centerId}/services?page=${page}&size=100&expand=additional_info&expand=catalog_info`);
      const list: any[] = d?.services ?? [];
      out.push(...list);
      const total = d?.page_info?.total ?? 0;
      if (!list.length || out.length >= total) break;
    }
    return out
      .filter((s) => s.allow_direct_booking !== false && s.catalog_info?.show_in_catalog !== false && s.is_addon !== true && s.is_active !== false)
      .map((s) => {
        const name = prettyName(s.name);
        const cat = pick(s.category_name, s.category?.name, s.additional_info?.category?.name, s.additional_info?.sub_category?.name);
        return {
          id: s.id,
          name,
          description: s.description || null,
          category: cat ? prettyName(cat) : guessCategory(name),
          duration: Number(pick(s.duration, s.time_info?.duration) ?? 0) || null,
          price: Number(pick(s.price_info?.final_price, s.price_info?.sale_price, s.price_info?.price, s.price) ?? 0) || null,
        };
      })
      .sort((a, b) => catOrder(a.category) - catOrder(b.category) || a.category.localeCompare(b.category) || a.name.localeCompare(b.name));
  });
}

// ---------------------------------------------------------------- guests
// Zenoti stores phone country as its own country id. India's id is looked up once from the centers' country,
// else from ZENOTI_INDIA_COUNTRY_ID, else Zenoti's usual id for India (95).
function indiaCountryId(center: any): number {
  const env = Number(Deno.env.get("ZENOTI_INDIA_COUNTRY_ID") ?? "");
  if (env) return env;
  const c = Number(center?.country_id ?? "");
  return c || 95;
}

async function findOrCreateGuest(center: any, p: { first_name: string; last_name: string; phone: string; email: string }) {
  const local = p.phone.slice(-10);
  // 1) search by phone, then by email
  for (const q of [`phone=${encodeURIComponent(local)}`, p.email ? `email=${encodeURIComponent(p.email)}` : ""]) {
    if (!q) continue;
    try {
      const d = await z("GET", `/v1/guests/search?center_id=${center.id}&${q}`);
      const g = (d?.guests ?? [])[0];
      if (g?.id) return g.id as string;
    } catch (e) { if (!(e instanceof ZenotiError && e.status === 404)) throw e; }
  }
  // 2) create
  const d = await z("POST", "/v1/guests", {
    center_id: center.id,
    personal_info: {
      first_name: p.first_name,
      last_name: p.last_name || ".",
      email: p.email || null,
      mobile_phone: { country_code: indiaCountryId(center), number: local },
    },
  });
  const id = d?.id ?? d?.guest?.id;
  if (!id) throw new ZenotiError(500, "Could not create the guest.", d);
  return id as string;
}

// ---------------------------------------------------------------- bookings
async function openBooking(row: { center_id: string; guest_id: string; service_id: string; date: string; therapist_gender: number }, onlyCatalog = true) {
  const item: any = { item: { id: row.service_id } };
  if (row.therapist_gender) item.therapist = { Gender: row.therapist_gender };
  const d = await z("POST", "/v1/bookings?is_double_booking_enabled=false", {
    center_id: row.center_id,
    date: row.date,
    is_only_catalog_employees: onlyCatalog,
    guests: [{ id: row.guest_id, items: [item] }],
  });
  console.log("zenoti booking raw", JSON.stringify(d).slice(0, 1500));
  const id = d?.id ?? d?.booking_id;
  if (!id) throw new ZenotiError(500, "Could not open a booking.", d);
  return id as string;
}

async function slotsFor(bookingId: string) {
  const d = await z("GET", `/v1/bookings/${bookingId}/slots?check_future_day_availability=true`);
  console.log("zenoti slots raw", JSON.stringify(d).slice(0, 1500));
  const raw: any[] = d?.slots ?? d?.Slots ?? [];
  const slots = raw
    .filter((s) => (s.Available ?? s.available) !== false)
    .map((s) => String(s.Time ?? s.time))
    .filter((t) => SLOT_RE.test(t.slice(0, 19)))
    .map((t) => t.slice(0, 19));
  const next = d?.next_available_day ?? d?.NextAvailableDay ?? null;
  return { slots, next_available_day: next ? String(next).slice(0, 10) : null };
}

const refRow = async (ref: string) => {
  if (!/^[0-9a-f-]{36}$/i.test(ref)) throw notFound();
  const [r] = await sql`select * from api_zenoti_booking where ref = ${ref}`;
  if (!r) throw notFound("This booking has expired. Please start again.");
  if (Date.now() - new Date(r.created_at).getTime() > 2 * 3600_000) throw bad({ detail: "This booking has expired. Please start again." });
  return r;
};

function checkDate(d: unknown) {
  const s = String(d ?? "");
  if (!DATE_RE.test(s) || isNaN(Date.parse(s))) throw bad({ detail: "Please choose a valid date." });
  const today = new Date(Date.now() + 5.5 * 3600_000).toISOString().slice(0, 10);
  if (s < today) throw bad({ detail: "Please choose today or a later date." });
  const max = new Date(Date.now() + 5.5 * 3600_000 + 90 * 86400_000).toISOString().slice(0, 10);
  if (s > max) throw bad({ detail: "Bookings can be made up to 90 days ahead." });
  return s;
}

// ---------------------------------------------------------------- routes
export function zenotiRoutes(route: RouteFn) {
  route("/booking/status", { GET: () => json({ configured: zenotiConfigured() }) }, { noAuth: true });

  route("/booking/centers", { GET: async () => {
    try { return json({ centers: (await centers()).map(({ country_id: _c, ...c }) => c) }); }
    catch (e) { friendly(e, "Could not load the salons."); }
  } }, { noAuth: true });

  route("/booking/centers/:id/services", { GET: async ({ params }) => {
    if (!ID_RE.test(params.id)) throw notFound();
    const c = (await centers().catch((e) => friendly(e, "Could not load the salons."))).find((x) => x.id === params.id);
    if (!c) throw notFound("Salon not found.");
    try { return json({ services: await services(c.id) }); }
    catch (e) { friendly(e, "Could not load the services."); }
  } }, { noAuth: true });

  route("/booking/start", { POST: async ({ body }) => {
    const d = await body();
    const errors: Record<string, string> = {};
    const first = String(d.first_name ?? "").trim().slice(0, 60);
    const last = String(d.last_name ?? "").trim().slice(0, 60);
    const email = String(d.email ?? "").trim().toLowerCase().slice(0, 254);
    const phoneDigits = String(d.phone ?? "").replace(/\D/g, "").replace(/^(91|0)(?=[6-9]\d{9}$)/, "");
    if (!first) errors.first_name = "Please enter your name.";
    if (!/^[6-9]\d{9}$/.test(phoneDigits)) errors.phone = "Please enter a valid 10-digit mobile number.";
    if (email && !EMAIL_RE.test(email)) errors.email = "Please enter a valid email.";
    if (Object.keys(errors).length) throw bad(errors);
    const date = checkDate(d.date);
    const gender = [0, 1, 2].includes(Number(d.therapist_gender)) ? Number(d.therapist_gender) : 0;
    const centerId = String(d.center_id ?? ""), serviceId = String(d.service_id ?? "");
    if (!ID_RE.test(centerId) || !ID_RE.test(serviceId)) throw bad({ detail: "Please choose a salon and a service." });

    // basic abuse guard: max 15 starts per phone per hour
    const [{ n }] = await sql`select count(*)::int n from api_zenoti_booking where phone = ${phoneDigits} and created_at > now() - interval '1 hour'`;
    if (n >= 15) throw new HttpError(429, { detail: "Too many attempts. Please try again later or call the salon." });

    try {
      const center = (await centers()).find((x) => x.id === centerId);
      if (!center) throw bad({ detail: "Salon not found." });
      const svc = (await services(center.id)).find((s) => s.id === serviceId);
      if (!svc) throw bad({ detail: "That service is not available at this salon." });
      const guestId = await findOrCreateGuest(center, { first_name: first, last_name: last, phone: normalisePhone(phoneDigits) ?? `91${phoneDigits}`, email });
      const bookingId = await openBooking({ center_id: center.id, guest_id: guestId, service_id: svc.id, date, therapist_gender: gender });
      const s = await slotsFor(bookingId);
      const [row] = await sql`insert into api_zenoti_booking
        (center_id, center_name, service_id, service_name, price, duration, guest_id, booking_id, first_name, last_name, phone, email, date, therapist_gender, status)
        values (${center.id}, ${center.name}, ${svc.id}, ${svc.name}, ${svc.price}, ${svc.duration}, ${guestId}, ${bookingId},
                ${first}, ${last}, ${phoneDigits}, ${email || null}, ${date}, ${gender}, 'started')
        returning ref`;
      return json({ ref: row.ref, date, ...s });
    } catch (e) { friendly(e, "Could not check availability."); }
  } }, { noAuth: true });

  route("/booking/:ref/date", { POST: async ({ params, body }) => {
    const r = await refRow(params.ref);
    if (r.status === "confirmed") throw bad({ detail: "This appointment is already booked." });
    const date = checkDate((await body()).date);
    try {
      const bookingId = await openBooking({ center_id: r.center_id, guest_id: r.guest_id, service_id: r.service_id, date, therapist_gender: r.therapist_gender });
      const s = await slotsFor(bookingId);
      if (!s.slots.length && Deno.env.get("ZENOTI_DIAG") !== "off") {
        // diagnostic only: does Zenoti have times when every stylist is allowed? (not used for the customer)
        try { const b2 = await openBooking({ center_id: r.center_id, guest_id: r.guest_id, service_id: r.service_id, date, therapist_gender: r.therapist_gender }, false); const s2 = await slotsFor(b2); console.log("zenoti diag all-employees slots", s2.slots.length, s2.next_available_day); } catch (e) { console.log("zenoti diag failed", String(e)); }
      }
      await sql`update api_zenoti_booking set booking_id = ${bookingId}, date = ${date}, updated_at = now() where ref = ${r.ref}`;
      return json({ ref: r.ref, date, ...s });
    } catch (e) { friendly(e, "Could not check availability."); }
  } }, { noAuth: true });

  route("/booking/:ref/confirm", { POST: async ({ params, body }) => {
    const r = await refRow(params.ref);
    if (r.status === "confirmed") return json(confirmedJson(r));
    const d = await body();
    const slot = String(d.slot_time ?? "").slice(0, 19);
    if (!SLOT_RE.test(slot) || !slot.startsWith(String(r.date).slice(0, 10))) throw bad({ detail: "Please choose a time." });
    const notes = String(d.notes ?? "").trim().slice(0, 500);
    try {
      const res = await z("POST", `/v1/bookings/${r.booking_id}/slots/reserve`, { slot_time: slot });
      if (res?.is_reserved === false) throw bad({ detail: "Sorry, that time was just taken. Please choose another time." });
      const conf = await z("POST", `/v1/bookings/${r.booking_id}/slots/confirm`, {
        notes: ["Booked on jajisinnovation.com", notes].filter(Boolean).join(" — "),
      });
      if (conf?.is_confirmed === false) throw bad({ detail: "Sorry, we couldn't confirm that time. Please choose another time." });
      const inv = conf?.invoice ?? {};
      const appt = inv?.items?.[0]?.appointment_id ?? inv?.appointment_id ?? conf?.appointment_id ?? null;
      const [row] = await sql`update api_zenoti_booking set status = 'confirmed', slot_time = ${slot}, notes = ${notes || null},
          invoice_id = ${inv?.invoice_id ?? inv?.id ?? null}, appointment_id = ${appt}, updated_at = now()
        where ref = ${r.ref} returning *`;
      return json(confirmedJson(row));
    } catch (e) {
      await sql`update api_zenoti_booking set status = 'failed', error = ${String((e as any)?.detail ?? (e as any)?.message ?? e).slice(0, 500)}, updated_at = now() where ref = ${r.ref}`.catch(() => {});
      if (e instanceof ZenotiError && /slot|available|reserv/i.test(e.detail)) throw bad({ detail: "Sorry, that time is no longer free. Please choose another time." });
      friendly(e, "Could not confirm the appointment.");
    }
  } }, { noAuth: true });

  // admin: see website bookings
  route("/admin/website-bookings", { GET: async ({ user }) => {
    if (!user?.is_staff) throw new HttpError(user ? 403 : 401, { detail: "Admins only." });
    const rows = await sql`select * from api_zenoti_booking order by created_at desc limit 200`;
    return json({ configured: zenotiConfigured(), bookings: rows.map((r) => ({ ...confirmedJson(r), status: r.status, error: r.error, created_at: iso(r.created_at) })) });
  } });
}

function confirmedJson(r: any) {
  return {
    ref: r.ref, status: r.status,
    center: r.center_name, service: r.service_name, price: r.price === null ? null : Number(r.price), duration: r.duration,
    date: String(r.date).slice(0, 10), slot_time: r.slot_time,
    name: `${r.first_name} ${r.last_name ?? ""}`.trim(), phone: r.phone, email: r.email,
    appointment_id: r.appointment_id, invoice_id: r.invoice_id,
  };
}
