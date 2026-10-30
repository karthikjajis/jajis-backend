// Database connection + small helpers shared by every route.
import postgres from "npm:postgres@3.4.5";

const url = Deno.env.get("SUPABASE_DB_URL") ?? Deno.env.get("DATABASE_URL");
if (!url) throw new Error("SUPABASE_DB_URL is not set");

export const sql = postgres(url, {
  prepare: false, // required behind Supabase's transaction pooler
  max: 3,
  idle_timeout: 20,
  connection: { TimeZone: "Asia/Kolkata" }, // match Django TIME_ZONE so timestamps print as +05:30
  types: {
    // bigint ids -> JS numbers (Django returns ints)
    bigint: { to: 20, from: [20], serialize: (x: number) => String(x), parse: (x: string) => Number(x) },
    // dates / timestamps -> raw strings, converted to DRF's ISO format in iso()
    rawtime: { to: 1184, from: [1082, 1114, 1184], serialize: (x: unknown) => x as string, parse: (x: string) => x },
  },
});

export type Tx = typeof sql;

/** "2026-10-29 19:01:37.464608+05:30" -> "2026-10-29T19:01:37.464608+05:30" (DRF style). */
export function iso(v: string | null | undefined): string | null {
  if (!v) return null;
  return v.replace(" ", "T");
}

/** Decimal string -> integer paise, so money maths never uses floats. */
export function paise(v: string | number | null | undefined): number {
  if (v === null || v === undefined || v === "") return 0;
  const s = String(v);
  const neg = s.startsWith("-");
  const [w, f = ""] = s.replace("-", "").split(".");
  const p = Number(w) * 100 + Number((f + "00").slice(0, 2));
  return neg ? -p : p;
}

/** integer paise -> "123.00" (Django DecimalField output) */
export function money(p: number): string {
  const neg = p < 0;
  const a = Math.abs(p);
  return `${neg ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}
