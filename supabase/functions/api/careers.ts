// Careers: public job list + applications (with CV upload to the private "resumes" storage bucket).
//   GET  /jobs                 -> open jobs (active and not past valid_through)
//   GET  /jobs/:id             -> one open job
//   POST /jobs/:id/apply       -> multipart/form-data or JSON; :id = "general" for a CV without a specific job
//   GET  /admin/applications/:id/resume -> short-lived link to the CV (staff only)
// Jobs and applications are edited in the admin panel through the generic /admin/r/jobs and /admin/r/applications.
import { sql, iso } from "./db.ts";
import { background, bad, EMAIL_RE, HttpError, json, notFound, readBody, type User } from "./util.ts";
import { sendJobApplicationEmails } from "./email.ts";

type Ctx = { req: Request; user: User | null; params: Record<string, string>; body: () => Promise<Record<string, any>> };
type RouteFn = (path: string, methods: Record<string, (c: Ctx) => Promise<Response> | Response>, opts?: { noAuth?: boolean }) => void;

export const BRANCHES = [
  "RP Mall, Kollam", "Signature Skin & Hair Clinic, RP Mall", "Polayathodu, Kollam", "Karunagappally", "Sasthamcotta", "Paravur", "Vazhuthacaud, Trivandrum",
  "Head Office, Kollam", "Q Café & Event Hall, Kollam", "Food Court, Kollam", "Designing & Stitching Studio, Polayathodu", "Jaji's Academy, Polayathodu",
];
export const EMPLOYMENT = ["FULL_TIME", "PART_TIME", "INTERN", "CONTRACTOR", "TEMPORARY"];

const SB_URL = () => Deno.env.get("SUPABASE_URL") ?? "";
const SB_KEY = () => Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MAX_CV = 5 * 1024 * 1024;
const CV_TYPES: Record<string, string> = {
  "application/pdf": "pdf", "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx", "image/jpeg": "jpg", "image/png": "png",
};

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const jobOut = (j: any) => ({
  id: j.id, title: j.title, branch: j.branch, employment_type: j.employment_type,
  salary_min: num(j.salary_min), salary_max: num(j.salary_max), experience: j.experience, description: j.description,
  valid_through: j.valid_through ? String(j.valid_through instanceof Date ? j.valid_through.toISOString() : j.valid_through).slice(0, 10) : null,
  posted_at: iso(j.created_at), updated_at: iso(j.updated_at),
});

export async function deleteResume(path: string | null) {
  if (!path) return;
  await fetch(`${SB_URL()}/storage/v1/object/resumes/${path}`, { method: "DELETE", headers: { Authorization: `Bearer ${SB_KEY()}`, apikey: SB_KEY() } })
    .catch((e) => console.error("cv delete", e));
}

async function signedUrl(path: string, seconds: number) {
  const r = await fetch(`${SB_URL()}/storage/v1/object/sign/resumes/${path}`, {
    method: "POST", headers: { Authorization: `Bearer ${SB_KEY()}`, apikey: SB_KEY(), "Content-Type": "application/json" },
    body: JSON.stringify({ expiresIn: seconds }),
  });
  if (!r.ok) throw new Error(`sign ${r.status}: ${await r.text()}`);
  const j = await r.json();
  return `${SB_URL()}/storage/v1${j.signedURL ?? j.signedUrl}`;
}

export function careersRoutes(route: RouteFn) {
  route("/jobs", { GET: async () => {
    const rows = await sql`select * from app_job where is_active and (valid_through is null or valid_through >= (now() at time zone 'Asia/Kolkata')::date) order by created_at desc`;
    return json({ jobs: rows.map(jobOut), branches: BRANCHES });
  } }, { noAuth: true });

  route("/jobs/:id", { GET: async ({ params }) => {
    const m = params.id.match(/^(\d+)/); if (!m) throw notFound("Job not found.");
    const [j] = await sql`select * from app_job where id = ${Number(m[1])} and is_active and (valid_through is null or valid_through >= (now() at time zone 'Asia/Kolkata')::date)`;
    if (!j) throw notFound("This job is no longer open.");
    return json(jobOut(j));
  } }, { noAuth: true });

  route("/jobs/:id/apply", { POST: async ({ req, params, body }) => {
    let job: any = null;
    if (params.id !== "general") {
      const m = params.id.match(/^(\d+)/); if (!m) throw notFound("Job not found.");
      [job] = await sql`select * from app_job where id = ${Number(m[1])} and is_active`;
      if (!job) throw bad({ detail: "Sorry, this job is no longer open." });
    }
    const d = await body();
    if (String(d.website ?? "").trim()) return json({ ok: true }); // honeypot: bots fill hidden fields
    const name = String(d.name ?? "").trim().slice(0, 120);
    const phone = String(d.phone ?? "").replace(/\D/g, "").replace(/^(91|0)(?=[6-9]\d{9}$)/, "");
    const email = String(d.email ?? "").trim().toLowerCase().slice(0, 254);
    const errors: Record<string, string> = {};
    if (name.length < 2) errors.name = "Please enter your full name.";
    if (!/^[6-9]\d{9}$/.test(phone)) errors.phone = "Please enter a valid 10-digit mobile number.";
    if (email && !EMAIL_RE.test(email)) errors.email = "Please enter a valid email.";
    const cv = d.resume instanceof File && d.resume.size > 0 ? d.resume as File : null;
    if (cv) {
      if (cv.size > MAX_CV) errors.resume = "CV must be 5 MB or smaller.";
      else if (!CV_TYPES[cv.type]) errors.resume = "Upload your CV as PDF, Word (DOC/DOCX), JPG or PNG.";
    }
    if (Object.keys(errors).length) throw bad(errors);
    const [{ n }] = await sql`select count(*)::int n from app_job_application where phone = ${phone} and created_at > now() - interval '1 day'`;
    if (n >= 5) throw new HttpError(429, { detail: "You've already sent several applications today. Our HR team will contact you." });

    let resumePath: string | null = null;
    if (cv) {
      resumePath = `${new Date().toISOString().slice(0, 7)}/${crypto.randomUUID()}.${CV_TYPES[cv.type]}`;
      const up = await fetch(`${SB_URL()}/storage/v1/object/resumes/${resumePath}`, {
        method: "POST", headers: { Authorization: `Bearer ${SB_KEY()}`, apikey: SB_KEY(), "Content-Type": cv.type, "x-upsert": "false" },
        body: await cv.arrayBuffer(),
      });
      if (!up.ok) { console.error("cv upload", up.status, await up.text()); throw new HttpError(500, { detail: "Could not upload your CV. Please try again." }); }
    }
    const row = {
      job_id: job?.id ?? null, job_title: job?.title ?? null, name, phone, email: email || null,
      city: String(d.city ?? "").trim().slice(0, 100) || null, experience: String(d.experience ?? "").trim().slice(0, 100) || null,
      message: String(d.message ?? "").trim().slice(0, 2000) || null, resume_path: resumePath, resume_name: cv ? cv.name.slice(0, 200) : null,
    };
    const [saved] = await sql`insert into app_job_application ${sql(row)} returning id`;
    background((async () => {
      const link = resumePath ? await signedUrl(resumePath, 7 * 86400).catch(() => null) : null;
      const r = await sendJobApplicationEmails(row, link);
      if (!r.ok) console.error("careers email failed", r.error);
    })());
    return json({ ok: true, id: saved.id }, 201);
  } }, { noAuth: true });

  route("/admin/applications/:id/resume", { GET: async ({ user, params }) => {
    if (!user?.is_staff) throw new HttpError(user ? 403 : 401, { detail: "Admins only." });
    if (!/^\d+$/.test(params.id)) throw notFound();
    const [a] = await sql`select resume_path from app_job_application where id = ${Number(params.id)}`;
    if (!a?.resume_path) throw notFound("No CV uploaded.");
    return json({ url: await signedUrl(a.resume_path, 600) });
  } });
}
