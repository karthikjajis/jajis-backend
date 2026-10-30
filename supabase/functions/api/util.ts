// HTTP helpers, CORS, DRF-compatible errors, token auth and Django password hashing.
import { sql } from "./db.ts";

// ---------------------------------------------------------------- CORS
const DEFAULT_ORIGINS = [
  "https://www.jajisinnovation.com",
  "https://jajisinnovation.com",
  "http://localhost:5173",
  "http://localhost:4173",
];
const ALLOWED = (Deno.env.get("CORS_ALLOWED_ORIGINS") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);
const ORIGINS = new Set([...DEFAULT_ORIGINS, ...ALLOWED]);

export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const allow = ORIGINS.has(origin) || (/^https:\/\/[a-z0-9-]*jajis[a-z0-9-]*\.vercel\.app$/.test(origin));
  return {
    ...(allow ? { "Access-Control-Allow-Origin": origin, "Vary": "Origin" } : {}),
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey, x-razorpay-signature",
    "Access-Control-Allow-Credentials": "true",
    "Access-Control-Max-Age": "86400",
  };
}

export class HttpError extends Error {
  constructor(public status: number, public body: unknown) {
    super(typeof body === "string" ? body : JSON.stringify(body));
  }
}

export const json = (body: unknown, status = 200) =>
  new Response(status === 204 ? null : JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

export const notFound = (detail = "Not found.") => new HttpError(404, { detail });
export const bad = (body: unknown) => new HttpError(400, body);

// ---------------------------------------------------------------- body parsing
export async function readBody(req: Request): Promise<Record<string, any>> {
  const ct = req.headers.get("content-type") ?? "";
  try {
    if (ct.includes("application/json")) return (await req.json()) ?? {};
    if (ct.includes("form")) {
      const fd = await req.formData();
      const o: Record<string, any> = {};
      fd.forEach((v, k) => (o[k] = typeof v === "string" ? v : v));
      return o;
    }
    const t = await req.text();
    return t ? JSON.parse(t) : {};
  } catch {
    throw bad({ detail: "JSON parse error" });
  }
}

/** Python int() semantics for request values; non-integers raise a 400 instead of a 500. */
export function toInt(v: unknown, field: string): number {
  const s = String(v ?? "").trim();
  if (!/^[+-]?\d+$/.test(s)) throw bad({ error: `${field} must be a whole number` });
  return Number(s);
}

// ---------------------------------------------------------------- auth (DRF TokenAuthentication)
export type User = {
  id: number; username: string; email: string; first_name: string; last_name: string;
  is_staff: boolean; is_superuser: boolean; is_active: boolean; date_joined: string;
};

/**
 * Mirrors rest_framework.authentication.TokenAuthentication:
 * - no "Token" header -> anonymous
 * - bad / unknown token -> 401 even on public endpoints (DRF behaviour)
 */
export async function authenticate(req: Request): Promise<User | null> {
  const h = req.headers.get("authorization") ?? "";
  const parts = h.trim().split(/\s+/);
  if (!h || parts[0].toLowerCase() !== "token") return null;
  if (parts.length === 1) throw new HttpError(401, { detail: "Invalid token header. No credentials provided." });
  if (parts.length > 2) throw new HttpError(401, { detail: "Invalid token header. Token string should not contain spaces." });
  const [u] = await sql<User[]>`
    select u.id, u.username, u.email, u.first_name, u.last_name, u.is_staff, u.is_superuser, u.is_active, u.date_joined
    from authtoken_token t join auth_user u on u.id = t.user_id where t.key = ${parts[1]}`;
  if (!u) throw new HttpError(401, { detail: "Invalid token." });
  if (!u.is_active) throw new HttpError(401, { detail: "User inactive or deleted." });
  return u;
}

export function requireUser(u: User | null): User {
  if (!u) throw new HttpError(401, { detail: "Authentication credentials were not provided." });
  return u;
}

export function fullName(u: { first_name?: string; last_name?: string; username: string }) {
  return `${u.first_name ?? ""} ${u.last_name ?? ""}`.trim() || u.username;
}

// ---------------------------------------------------------------- Django password hashing (pbkdf2_sha256)
const enc = new TextEncoder();
const b64 = (buf: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(buf)));

async function pbkdf2(password: string, salt: string, iterations: number) {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations }, key, 256);
  return b64(bits);
}

function safeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

/** Same check as django.contrib.auth.hashers.check_password for pbkdf2_sha256 hashes. */
export async function checkPassword(password: string, encoded: string): Promise<boolean> {
  const [algo, iters, salt, hash] = (encoded ?? "").split("$");
  if (algo !== "pbkdf2_sha256" || !iters || !salt || !hash) return false;
  return safeEqual(await pbkdf2(password, salt, Number(iters)), hash);
}

const ALNUM = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
function randomString(n: number, alphabet = ALNUM) {
  const out: string[] = [];
  const buf = new Uint32Array(n);
  crypto.getRandomValues(buf);
  for (let i = 0; i < n; i++) out.push(alphabet[buf[i] % alphabet.length]);
  return out.join("");
}

/** Same format Django 5.2 writes, so the Django backend could still read these hashes. */
export async function makePassword(password: string): Promise<string> {
  const iterations = 1_000_000;
  const salt = randomString(22);
  return `pbkdf2_sha256$${iterations}$${salt}$${await pbkdf2(password, salt, iterations)}`;
}

/** DRF Token.generate_key(): 40 hex chars. */
export function newTokenKey(): string {
  const b = new Uint8Array(20);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

export function randomDigits(n: number) {
  return randomString(n, "0123456789");
}

// ---------------------------------------------------------------- images (Cloudinary, as django-cloudinary-storage)
const CLOUD = Deno.env.get("CLOUDINARY_CLOUD_NAME") ?? "";
export function img(name: string | null | undefined): string | null {
  if (!name) return null;
  if (/^https?:\/\//.test(name)) return name;
  // django-cloudinary-storage prepends MEDIA prefix "media/" when the stored name lacks it
  const id = name.startsWith("media/") ? name : `media/${name}`;
  return `https://res.cloudinary.com/${CLOUD}/image/upload/v1/${id}`;
}

// ---------------------------------------------------------------- misc
export function esc(v: unknown): string {
  return String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Today's date in India (Django runs with TIME_ZONE=Asia/Kolkata). */
export function todayIST(): string {
  const d = new Date(Date.now() + 330 * 60_000);
  return d.toISOString().slice(0, 10);
}
