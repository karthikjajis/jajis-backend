// Public feeds for search engines, generated live from the shop database.
//   GET /feeds/sitemap.xml          – every page + every product page, for Google Search
//   GET /feeds/google-products.xml  – Google Merchant Center product feed (free Shopping listings)
// The website proxies /sitemap.xml and /google-products.xml to these (Vercel project routes).
import postgres from "npm:postgres@3.4.5";

const SITE = "https://www.jajisinnovation.com";
const CLOUD = Deno.env.get("CLOUDINARY_CLOUD_NAME") ?? "";
const url = Deno.env.get("SUPABASE_DB_URL") ?? Deno.env.get("DATABASE_URL");
if (!url) throw new Error("SUPABASE_DB_URL is not set");
const sql = postgres(url, { prepare: false, max: 2, idle_timeout: 20 });

const STATIC_PAGES = [
  ["/", "1.0"],
  ["/products", "0.9"],
  ["/salons", "0.8"],
  ["/cosmetics", "0.7"],
  ["/academy", "0.7"],
  ["/event-hall", "0.7"],
  ["/food-court", "0.6"],
  ["/designing-stitching", "0.6"],
  ["/franchise", "0.6"],
  ["/about-us", "0.5"],
  ["/management", "0.4"],
  ["/contact", "0.5"],
];

const esc = (v: unknown) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]!));

/** Stored Cloudinary name -> a JPEG URL Google accepts (some originals are AVIF). */
function image(name: string | null): string | null {
  if (!name) return null;
  if (/^https?:\/\//.test(name)) return name;
  const id = name.startsWith("media/") ? name : `media/${name}`;
  return `https://res.cloudinary.com/${CLOUD}/image/upload/f_jpg,q_auto,w_1200/v1/${id}`;
}

const brand = (b: string | null) => (!b || /^jajis?'?s?$/i.test(b.trim()) ? "Jaji's" : b.trim());
const plain = (s: string | null) => String(s ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
const inr = (v: string) => `${Number(v).toFixed(2)} INR`;

async function products() {
  return await sql`
    select p.id, p.title, p.description, p.brand, p.image1, p.image2, p.image3, p.image4,
           coalesce(p.updated_at, p.created_at) as updated, c.name as category,
           v.id as variant_id, v.quantity_label, v.mrp::text as mrp, v.price::text as price, v.stock, v.sku,
           count(*) over (partition by p.id) as variant_count
    from app_product p
    join app_productvariant v on v.product_id = p.id
    left join app_category c on c.id = p.category_id
    order by p.id, v.id`;
}

async function sitemap() {
  const rows = await sql`select id, coalesce(updated_at, created_at) as updated from app_product order by id`;
  const urls = [
    ...STATIC_PAGES.map(([path, pr]) => `<url><loc>${SITE}${path}</loc><priority>${pr}</priority></url>`),
    ...rows.map(
      (r) =>
        `<url><loc>${SITE}/product/${r.id}</loc>${
          r.updated ? `<lastmod>${new Date(r.updated).toISOString().slice(0, 10)}</lastmod>` : ""
        }<priority>0.8</priority></url>`,
    ),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

async function merchantFeed() {
  const rows = await products();
  const items = rows.map((r) => {
    const imgs = [r.image1, r.image2, r.image3, r.image4].map(image).filter(Boolean) as string[];
    const multi = Number(r.variant_count) > 1;
    const title = multi && r.quantity_label ? `${r.title} – ${r.quantity_label}` : r.title;
    const mrp = Number(r.mrp);
    const price = Number(r.price);
    const onSale = mrp > price && price > 0;
    return `<item>
  <g:id>${esc(r.sku || `JAJIS-${r.variant_id}`)}</g:id>
  ${multi ? `<g:item_group_id>JAJIS-P${r.id}</g:item_group_id>` : ""}
  <g:title>${esc(plain(title).slice(0, 150))}</g:title>
  <g:description>${esc(plain(r.description || r.title).slice(0, 5000))}</g:description>
  <g:link>${SITE}/product/${r.id}</g:link>
  ${imgs[0] ? `<g:image_link>${esc(imgs[0])}</g:image_link>` : ""}
  ${imgs.slice(1).map((u) => `<g:additional_image_link>${esc(u)}</g:additional_image_link>`).join("")}
  <g:availability>${Number(r.stock) > 0 ? "in_stock" : "out_of_stock"}</g:availability>
  <g:price>${inr(onSale ? r.mrp : r.price)}</g:price>
  ${onSale ? `<g:sale_price>${inr(r.price)}</g:sale_price>` : ""}
  <g:brand>${esc(brand(r.brand))}</g:brand>
  <g:condition>new</g:condition>
  <g:identifier_exists>no</g:identifier_exists>
  ${r.quantity_label ? `<g:size>${esc(r.quantity_label)}</g:size>` : ""}
  ${r.category ? `<g:product_type>${esc(r.category)}</g:product_type>` : ""}
  <g:google_product_category>469</g:google_product_category>
</item>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">
<channel>
<title>Jaji's Innovation – Shop</title>
<link>${SITE}/products</link>
<description>Hair and skin care from Jaji's Innovation, Kerala.</description>
${items.join("\n")}
</channel>
</rss>
`;
}

Deno.serve(async (req) => {
  const path = new URL(req.url).pathname.replace(/^\/functions\/v1/, "").replace(/^\/feeds/, "");
  try {
    let body: string;
    if (path === "/sitemap.xml") body = await sitemap();
    else if (path === "/google-products.xml") body = await merchantFeed();
    else return new Response("Not found", { status: 404 });
    return new Response(body, {
      headers: {
        "content-type": "application/xml; charset=utf-8",
        "cache-control": "public, max-age=3600",
        "access-control-allow-origin": "*",
      },
    });
  } catch (e) {
    console.error(e);
    return new Response("Feed temporarily unavailable", { status: 503 });
  }
});
