// WhatsApp Business Cloud API (Meta) — order alerts.
// Stays switched off until WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are set as Supabase secrets.
//
// Secrets:
//   WHATSAPP_TOKEN            permanent System User access token (Meta Business settings)
//   WHATSAPP_PHONE_NUMBER_ID  "Phone number ID" from WhatsApp Manager → API setup
//   WHATSAPP_ADMIN_NUMBERS    comma-separated numbers that get "new order" alerts, e.g. 919876543210,918893388090
//   WHATSAPP_ORDER_TEMPLATE   customer template name   (default: order_confirmation)
//   WHATSAPP_ADMIN_TEMPLATE   staff alert template name (default: new_order_alert)
//   WHATSAPP_SHIPPED_TEMPLATE customer "shipped" template (default: order_shipped)
//   WHATSAPP_TEMPLATE_LANG    template language code   (default: en)

const TOKEN = Deno.env.get("WHATSAPP_TOKEN") ?? "";
const PHONE_ID = Deno.env.get("WHATSAPP_PHONE_NUMBER_ID") ?? "";
const LANG = Deno.env.get("WHATSAPP_TEMPLATE_LANG") ?? "en";
const GRAPH = "https://graph.facebook.com/v21.0";

export const WA = {
  order: Deno.env.get("WHATSAPP_ORDER_TEMPLATE") ?? "order_confirmation",
  admin: Deno.env.get("WHATSAPP_ADMIN_TEMPLATE") ?? "new_order_alert",
  shipped: Deno.env.get("WHATSAPP_SHIPPED_TEMPLATE") ?? "order_shipped",
};
export const whatsappConfigured = () => Boolean(TOKEN && PHONE_ID);
export const adminNumbers = () =>
  (Deno.env.get("WHATSAPP_ADMIN_NUMBERS") ?? "").split(",").map(normalisePhone).filter(Boolean) as string[];

/** Indian numbers: keep digits, drop a leading 0, add 91 to 10-digit numbers. */
export function normalisePhone(p: string | null | undefined): string | null {
  let d = String(p ?? "").replace(/\D/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 11 && d.startsWith("0")) d = d.slice(1);
  if (d.length === 10) d = "91" + d;
  return d.length >= 11 && d.length <= 15 ? d : null;
}

// Template variables may not contain newlines, tabs or 4+ spaces in a row.
const clean = (v: unknown) => String(v ?? "-").replace(/[\n\r\t]+/g, " ").replace(/ {4,}/g, "   ").trim().slice(0, 900) || "-";

export type WaResult = { ok: boolean; status?: number; error?: string; id?: string };

export async function sendTemplate(to: string | null | undefined, template: string, params: unknown[]): Promise<WaResult> {
  if (!whatsappConfigured()) return { ok: false, error: "WhatsApp is not set up yet (WHATSAPP_TOKEN / WHATSAPP_PHONE_NUMBER_ID missing)." };
  const num = normalisePhone(to);
  if (!num) return { ok: false, error: `Not a valid phone number: ${to ?? "(none)"}` };
  try {
    const r = await fetch(`${GRAPH}/${PHONE_ID}/messages`, {
      method: "POST",
      headers: { "Authorization": `Bearer ${TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp", to: num, type: "template",
        template: {
          name: template, language: { code: LANG },
          ...(params.length ? { components: [{ type: "body", parameters: params.map((p) => ({ type: "text", text: clean(p) })) }] } : {}),
        },
      }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) {
      const error = body?.error?.error_data?.details || body?.error?.message || `HTTP ${r.status}`;
      console.error(`WhatsApp API error (${template} → ${num}): ${r.status} - ${JSON.stringify(body)}`);
      return { ok: false, status: r.status, error };
    }
    return { ok: true, status: r.status, id: body?.messages?.[0]?.id };
  } catch (e) {
    console.error("WhatsApp send failed:", e);
    return { ok: false, error: String(e) };
  }
}
