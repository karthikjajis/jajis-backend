// Brevo emails — same subjects, recipients and HTML as the Django app/email.py.
import { esc, fullName } from "./util.ts";

const BREVO_API_KEY = Deno.env.get("BREVO_API_KEY") ?? "";
const FROM = Deno.env.get("DEFAULT_FROM_EMAIL") ?? "";
const ADMIN_EMAIL = Deno.env.get("ADMIN_NOTIFY_EMAIL") ?? "managingdirector@jajis.in";

export type MailResult = { ok: boolean; status?: number; error?: string };

async function send(to: string[], subject: string, text: string, html: string): Promise<MailResult> {
  if (!BREVO_API_KEY || !FROM) {
    console.error("Email not sent (BREVO_API_KEY / DEFAULT_FROM_EMAIL missing):", subject);
    return { ok: false, error: "Email is not set up (BREVO_API_KEY / DEFAULT_FROM_EMAIL missing)." };
  }
  try {
    const r = await fetch(Deno.env.get("BREVO_API_URL") ?? "https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "Accept": "application/json", "Content-Type": "application/json", "api-key": BREVO_API_KEY },
      body: JSON.stringify({
        sender: { name: Deno.env.get("EMAIL_SENDER_NAME") ?? "Jaji's", email: FROM },
        to: to.filter(Boolean).map((email) => ({ email })),
        subject, textContent: text, htmlContent: html,
      }),
    });
    if (!r.ok) {
      const body = await r.text();
      console.error(`Brevo API error: ${r.status} - ${body}`);
      let error = body;
      try { error = JSON.parse(body).message ?? body; } catch { /* plain text */ }
      if (/unrecognised IP/i.test(error)) {
        error = "Brevo blocked the server's IP address. In Brevo go to Security → Authorised IPs and deactivate IP blocking.";
      }
      return { ok: false, status: r.status, error };
    }
    return { ok: true, status: r.status };
  } catch (e) {
    console.error("Failed to send email via Brevo:", e);
    return { ok: false, error: String(e) };
  }
}

export const emailStatus = () => ({ configured: Boolean(BREVO_API_KEY && FROM), from: FROM, admin: ADMIN_EMAIL });

export function sendTestEmail(to: string) {
  const when = new Date().toLocaleString("en-IN", { timeZone: "Asia/Kolkata" });
  return send([to], "Test email from jajisinnovation.com",
    `This is a test email from your website (${when}). If you can read this, order and enquiry emails are working.`,
    `<div style="font-family:Arial,sans-serif;font-size:15px;color:#111"><h2 style="margin:0 0 8px">Emails are working ✓</h2>
     <p>This is a test email from jajisinnovation.com, sent ${when}.</p>
     <p>Order confirmations, password reset codes, event hall and franchise enquiry emails all use this same sender.</p></div>`);
}

const shell = (title: string, inner: string, width = 600) => `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>${title}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f6f8;font-family:Arial,Helvetica,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0">
<tr>
<td align="center" style="padding:40px 15px;">
    <table width="${width}" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:12px;padding:30px;box-shadow:0 10px 30px rgba(0,0,0,0.08);">
${inner}
    </table>
</td>
</tr>
</table>
</body>
</html>`;

const DIV = `<tr><td style="border-top:1px solid #e5e7eb;"></td></tr>`;
const row = (k: string, v: string, last = false, style = "") =>
  `<tr${last ? "" : ' style="border-bottom:1px solid #f3f4f6;"'}><td style="padding:8px 0;"><strong>${k}</strong></td><td align="right"${style ? ` style="${style}"` : ""}>${v}</td></tr>`;

// ------------------------------------------------------------------ order confirmation
export async function sendOrderSuccessEmail(
  user: { username: string; email: string; first_name?: string; last_name?: string },
  order: { id: number; total_amount: string; shipping_cost?: string | null; transaction_id: string | null; payment_method: string | null },
  addr: Record<string, any> | null,
  items: { title: string; quantity_label: string; quantity: number; total_price: string }[],
) {
  const name = fullName(user);
  const text = `
Hello ${name},

Your payment was successful.

Order ID: ${order.id}
Shipping: ${Number(order.shipping_cost || 0) > 0 ? `₹${order.shipping_cost}` : "Free"}
Total Amount: ₹${order.total_amount}

Thank you for shopping with us.
`;
  const itemsHtml = items.map((i) => `
        <tr>
            <td style="padding:10px 0;">${esc(i.title)}<br>
                <span style="color:#6b7280;font-size:13px;">
                    ${esc(i.quantity_label)}
                </span>
            </td>
            <td style="text-align:center;">${i.quantity}</td>
            <td style="text-align:right;">₹${i.total_price}</td>
        </tr>`).join("");
  const a = addr ?? {};
  const html = shell("Order Confirmation", `
        <tr>
            <td style="text-align:center;padding-bottom:25px;">
                <h1 style="margin:0;font-size:26px;color:#111827;">Payment Successful 🎉</h1>
                <p style="margin:8px 0 0;color:#6b7280;">Thank you for your purchase</p>
            </td>
        </tr>
        ${DIV}
        <tr>
            <td style="padding:25px 0;">
                <h3 style="margin:0 0 12px;color:#111827;">Order Details</h3>
                <table width="100%">
                    <tr><td>Order ID</td><td align="right">#${order.id}</td></tr>
                    <tr><td>Payment ID</td><td align="right">${esc(order.transaction_id)}</td></tr>
                    <tr><td>Payment Method</td><td align="right">${esc(order.payment_method)}</td></tr>
                    <tr><td>Status</td><td align="right" style="color:#16a34a;font-weight:bold;">Paid</td></tr>
                    <tr><td>Shipping</td><td align="right">${Number(order.shipping_cost || 0) > 0 ? `₹${order.shipping_cost}` : "Free"}</td></tr>
                    <tr><td><strong>Total</strong></td><td align="right"><strong>₹${order.total_amount}</strong></td></tr>
                </table>
            </td>
        </tr>
        ${DIV}
        <tr>
            <td style="padding:25px 0;">
                <h3 style="margin:0 0 12px;color:#111827;">Shipping Address</h3>
                <p style="margin:0;color:#374151;line-height:1.6;">
                    ${esc(name)}<br>
                    ${esc(a.line1)}<br>
                    ${a.line2 ? esc(a.line2) + "<br>" : ""}
                    ${esc(a.city)}, ${esc(a.state)}<br>
                    ${esc(a.postal_code)}<br>
                    Phone: ${esc(a.phone)}
                </p>
            </td>
        </tr>
        ${DIV}
        <tr>
            <td style="padding:25px 0;">
                <h3 style="margin:0 0 15px;color:#111827;">Items Purchased</h3>
                <table width="100%" style="border-collapse:collapse;">
                    <tr style="border-bottom:1px solid #e5e7eb;font-weight:bold;">
                        <td>Product</td><td align="center">Qty</td><td align="right">Price</td>
                    </tr>
                    ${itemsHtml}
                </table>
            </td>
        </tr>
        <tr>
            <td style="padding-top:30px;text-align:center;">
                <p style="margin:0;color:#6b7280;font-size:14px;">We will notify you once your order is shipped.</p>
                <p style="margin:15px 0 0;font-size:13px;color:#9ca3af;">© ${esc(FROM)}</p>
                <p style="margin:15px 0 0;font-size:13px;color:#9ca3af;">
                    <a href="https://www.jajisinnovation.com" style="color:#9ca3af;text-decoration:none;">Visit www.jajisinnovation.com to see more</a>
                </p>
            </td>
        </tr>`);
  return send([user.email, FROM], `Order Confirmation – Order #${order.id}`, text, html);
}

// ------------------------------------------------------------------ password reset OTP
export async function sendPasswordResetOtpEmail(
  user: { username: string; email: string; first_name?: string; last_name?: string }, otp: string,
) {
  const name = fullName(user);
  const text = `
Hello ${name},

Your username is: ${user.username}

You requested a password reset. Your OTP is: ${otp}

This OTP will expire in 10 minutes.

If you didn't request this, please ignore this email.
`;
  const html = shell("Password Reset OTP", `
    <tr>
    <td>
        <h1 style="color:#1f2937;margin:0 0 20px 0;">Password Reset Request</h1>
        <p style="color:#6b7280;margin:0 0 15px 0;">Hello ${esc(name)},</p>
        <p style="color:#6b7280;margin:0 0 15px 0;">Your username is: <strong>${esc(user.username)}</strong></p>
        <p style="color:#6b7280;margin:0 0 15px 0;">You requested a password reset. Your OTP is:</p>
        <div style="background:#f3f4f6;padding:20px;text-align:center;border-radius:8px;margin:20px 0;">
            <span style="font-size:24px;font-weight:bold;color:#1f2937;">${otp}</span>
        </div>
        <p style="color:#6b7280;margin:0 0 15px 0;">This OTP will expire in 10 minutes.</p>
        <p style="color:#6b7280;margin:0;">If you didn't request this, please ignore this email.</p>
    </td>
    </tr>`);
  await send([user.email], "Password Reset OTP - Jaji's", text, html);
}

// ------------------------------------------------------------------ event hall
const EVENT_TYPES: Record<string, string> = {
  wedding: "Wedding", reception: "Reception", birthday: "Birthday", corporate: "Corporate", other: "Other",
};
const CATEGORIES: Record<string, string> = { ac: "AC", "non-ac": "Non-AC" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const longDate = (d: string) => {
  const [y, m, day] = d.split("-").map(Number);
  return `${MONTHS[m - 1]} ${String(day).padStart(2, "0")}, ${y}`;
};

type EventHall = { name: string; phone: string; email: string; event_type: string; category: string; event_date: string };

export async function sendEventHallEmails(e: EventHall) {
  const type = EVENT_TYPES[e.event_type] ?? e.event_type;
  const cat = CATEGORIES[e.category] ?? e.category;
  const date = longDate(e.event_date);

  const userText = `
Hello ${e.name},

Thank you for your interest in Jaji's Event Hall! We have received your booking enquiry.

Here are your submitted details:
- Name: ${e.name}
- Phone: ${e.phone}
- Email: ${e.email}
- Event Type: ${type}
- Category: ${cat}
- Requested Event Date: ${date}

Our team will review your request and get in touch with you soon to confirm your booking.

Best regards,
Jaji's Team
`;
  const userHtml = shell("Event Hall Booking Request Received", `
        <tr>
            <td style="text-align:center;padding-bottom:20px;">
                <h1 style="margin:0;font-size:24px;color:#111827;">Booking Enquiry Received 🎉</h1>
                <p style="margin:8px 0 0;color:#6b7280;">Thank you for reaching out to Jaji's Event Hall</p>
            </td>
        </tr>
        ${DIV}
        <tr>
            <td style="padding:25px 0;">
                <h3 style="margin:0 0 15px;color:#111827;">Enquiry Details</h3>
                <table width="100%" style="border-collapse:collapse;font-size:14px;color:#374151;">
                    ${row("Name:", esc(e.name))}
                    ${row("Phone:", esc(e.phone))}
                    ${row("Email:", esc(e.email))}
                    ${row("Event Type:", esc(type))}
                    ${row("Category:", esc(cat))}
                    ${row("Requested Event Date:", date, true, "color:#2563eb;font-weight:bold;")}
                </table>
            </td>
        </tr>
        ${DIV}
        <tr>
            <td style="padding-top:25px;text-align:center;color:#6b7280;font-size:14px;">
                <p style="margin:0;">Our event coordinator will contact you shortly to confirm the availability and discuss details.</p>
                <p style="margin:15px 0 0;font-size:13px;color:#9ca3af;">© Jaji's Innovation</p>
            </td>
        </tr>`);

  const adminText = `
New Event Hall Booking Enquiry Received!

Details:
- Customer Name: ${e.name}
- Phone: ${e.phone}
- Email: ${e.email}
- Event Type: ${type}
- Category: ${cat}
- Event Date: ${date}

Please log in to the admin panel to review and manage this lead.
`;
  const adminHtml = shell("New Event Hall Enquiry", `
        <tr>
            <td style="text-align:center;padding-bottom:20px;">
                <h1 style="margin:0;font-size:24px;color:#111827;">New Event Hall Lead 📩</h1>
                <p style="margin:8px 0 0;color:#6b7280;">Enquiry submitted on website</p>
            </td>
        </tr>
        ${DIV}
        <tr>
            <td style="padding:25px 0;">
                <h3 style="margin:0 0 15px;color:#111827;">Customer & Booking Details</h3>
                <table width="100%" style="border-collapse:collapse;font-size:14px;color:#374151;">
                    ${row("Customer Name:", esc(e.name))}
                    ${row("Phone Number:", `<a href="tel:${esc(e.phone)}" style="color:#2563eb;">${esc(e.phone)}</a>`)}
                    ${row("Email Address:", `<a href="mailto:${esc(e.email)}" style="color:#2563eb;">${esc(e.email)}</a>`)}
                    ${row("Event Type:", esc(type))}
                    ${row("Category:", esc(cat))}
                    ${row("Requested Event Date:", date, true, "color:#dc2626;font-weight:bold;")}
                </table>
            </td>
        </tr>
        ${DIV}
        <tr>
            <td style="padding-top:25px;text-align:center;color:#6b7280;font-size:14px;">
                <p style="margin:0;">This lead is saved in the e-commerce admin panel.</p>
            </td>
        </tr>`);

  await Promise.all([
    send([e.email], "Event Hall Booking Request Received - Jaji's", userText, userHtml),
    send([ADMIN_EMAIL], `New Event Hall Booking Enquiry - ${e.name}`, adminText, adminHtml),
  ]);
}

// ------------------------------------------------------------------ franchise
export async function sendFranchiseEmails(q: Record<string, any>) {
  const na = (v: unknown) => (v ? String(v) : "N/A");
  const userText = `
Dear ${q.full_name},

Thank you for your interest in becoming a Jaji’s franchise partner.

Our franchise development team will review your application details for ${q.preferred_city} and contact shortlisted applicants for an initial discussion.

Submission of this form does not constitute a franchise agreement or guarantee franchise approval.

Best regards,
Jaji’s Innovation Pvt. Ltd.
www.jajisinnovation.com
`;
  const P = (t: string) => `<p style="margin:0 0 15px;color:#374151;font-size:15px;line-height:1.6;">${t}</p>`;
  const userHtml = shell("Franchise Enquiry Confirmation", `
        <tr>
            <td style="text-align:center;padding-bottom:20px;">
                <h1 style="margin:0;font-size:24px;color:#111827;">Thank You for Your Enquiry! ✨</h1>
                <p style="margin:8px 0 0;color:#6b7280;">Jaji’s Official Partner Program</p>
            </td>
        </tr>
        ${DIV}
        <tr>
            <td style="padding:25px 0;">
                ${P(`Dear <strong>${esc(q.full_name)}</strong>,`)}
                ${P(`Thank you for expressing your interest in joining the Jaji’s franchise network. We have received your application for <strong>${esc(q.preferred_city)}, ${esc(q.state)}</strong>.`)}
                ${P("Our franchise development team will review your application details and reach out to shortlisted applicants for an initial discussion.")}
            </td>
        </tr>
        ${DIV}
        <tr>
            <td style="padding-top:25px;text-align:center;color:#6b7280;font-size:13px;">
                <p style="margin:0;font-weight:bold;color:#111827;">Jaji’s Innovation Pvt. Ltd.</p>
                <p style="margin:4px 0 0;">Growing together. Creating successful beauty businesses.</p>
                <p style="margin:12px 0 0;"><a href="https://www.jajisinnovation.com" style="color:#2563eb;text-decoration:none;">www.jajisinnovation.com</a></p>
            </td>
        </tr>`);

  const adminText = `
New Franchise Partner Enquiry Received!

Personal Details:
- Full Name: ${q.full_name}
- Mobile Number: ${q.mobile_number}
- WhatsApp Number: ${na(q.whatsapp_number)}
- Email: ${q.email}
- Age Group: ${q.age_group}
- Current Location: ${q.current_city_district}, ${q.state}

Business Information:
- Current Occupation: ${q.occupation}
- Previous Business Exp: ${q.has_business_exp}
- Business Exp Details: ${na(q.business_exp_details)}
- Salon/Beauty Industry Exp: ${q.has_salon_exp}
- Applicant Type: ${q.applicant_type}

Proposed Location:
- Preferred City/Town: ${q.preferred_city}
- Preferred Area: ${q.preferred_area}
- Commercial Property Status: ${q.has_commercial_property}
- Property Size: ${na(q.property_size)}
- Property Map Link: ${na(q.property_location_link)}

Investment Details:
- Available Budget: ${q.investment_budget}
- Investment Source: ${q.investment_source}
- Start Timeline: ${q.plan_to_start}
- Daily Operations Involvement: ${q.daily_operations_involvement}
`;
  const r6 = (k: string, v: string, last = false, style = "") =>
    `<tr${last ? "" : ' style="border-bottom:1px solid #f3f4f6;"'}><td style="padding:6px 0;"><strong>${k}</strong></td><td align="right"${style ? ` style="${style}"` : ""}>${v}</td></tr>`;
  const section = (title: string, rows: string) => `
        <tr>
            <td style="padding:20px 0;">
                <h3 style="margin:0 0 12px;color:#111827;font-size:16px;">${title}</h3>
                <table width="100%" style="border-collapse:collapse;font-size:14px;color:#374151;">${rows}</table>
            </td>
        </tr>
        ${DIV}`;
  const link = q.property_location_link && /^https?:\/\//i.test(q.property_location_link)
    ? `<a href="${esc(q.property_location_link)}" style="color:#2563eb;">View Link</a>` : esc(q.property_location_link);
  const adminHtml = shell("New Franchise Enquiry", `
        <tr>
            <td style="text-align:center;padding-bottom:20px;">
                <h1 style="margin:0;font-size:24px;color:#111827;">New Franchise Lead 🤝</h1>
                <p style="margin:8px 0 0;color:#6b7280;">Enquiry submitted on website</p>
            </td>
        </tr>
        ${DIV}
        ${section("1. Personal Details",
          r6("Full Name:", esc(q.full_name)) +
          r6("Mobile:", `<a href="tel:${esc(q.mobile_number)}" style="color:#2563eb;">${esc(q.mobile_number)}</a>`) +
          r6("WhatsApp:", esc(na(q.whatsapp_number))) +
          r6("Email:", `<a href="mailto:${esc(q.email)}" style="color:#2563eb;">${esc(q.email)}</a>`) +
          r6("Age Group:", esc(q.age_group)) +
          r6("Current City & State:", `${esc(q.current_city_district)}, ${esc(q.state)}`, true))}
        ${section("2. Business Information",
          r6("Current Occupation:", esc(q.occupation)) +
          r6("Business Experience:", esc(q.has_business_exp)) +
          (q.business_exp_details ? r6("Business Details:", esc(q.business_exp_details)) : "") +
          r6("Salon/Beauty Exp:", esc(q.has_salon_exp)) +
          r6("Applicant Type:", esc(q.applicant_type), true))}
        ${section("3. Proposed Franchise Location",
          r6("Preferred City:", esc(q.preferred_city), false, "font-weight:bold;color:#111827;") +
          r6("Preferred Area:", esc(q.preferred_area)) +
          r6("Commercial Property:", esc(q.has_commercial_property)) +
          r6("Property Size:", esc(na(q.property_size)), !q.property_location_link) +
          (q.property_location_link ? r6("Location Link:", link, true) : ""))}
        ${section("4. Investment Details",
          r6("Investment Budget:", esc(q.investment_budget), false, "color:#16a34a;font-weight:bold;") +
          r6("Source of Funds:", esc(q.investment_source)) +
          r6("Start Timeline:", esc(q.plan_to_start)) +
          r6("Daily Involvement:", esc(q.daily_operations_involvement), true))}
        <tr>
            <td style="padding-top:20px;text-align:center;color:#6b7280;font-size:13px;">
                <p style="margin:0;">This lead is registered in the Jaji’s admin system.</p>
            </td>
        </tr>`, 650);

  await Promise.all([
    send([q.email], "Thank You for Your Jaji’s Franchise Enquiry", userText, userHtml),
    send([ADMIN_EMAIL], `New Franchise Partner Enquiry - ${q.full_name} (${q.preferred_city})`, adminText, adminHtml),
  ]);
}
