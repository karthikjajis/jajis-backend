// Tiny DRF-style field validation so error responses look the same as before.
import { bad, EMAIL_RE } from "./util.ts";

export type Field =
  | { type: "str"; max?: number; required?: boolean; blank?: boolean; nullable?: boolean; default?: unknown }
  | { type: "email"; max?: number; required?: boolean; blank?: boolean }
  | { type: "bool"; required?: boolean; default?: boolean }
  | { type: "date"; required?: boolean }
  | { type: "choice"; choices: string[]; required?: boolean };

const TRUE = new Set([true, "true", "True", "1", 1, "on", "yes"]);
const FALSE = new Set([false, "false", "False", "0", 0, "off", "no"]);

/** Returns only the provided (or defaulted) fields; throws 400 {field: [msg]} like DRF. */
export function validate(data: Record<string, any>, spec: Record<string, Field>, partial = false) {
  const out: Record<string, any> = {};
  const errors: Record<string, string[]> = {};
  for (const [k, f] of Object.entries(spec)) {
    const has = Object.prototype.hasOwnProperty.call(data, k);
    let v = data[k];
    if (!has) {
      if ("default" in f && f.default !== undefined && !partial) out[k] = f.default;
      else if (f.required && !partial) errors[k] = ["This field is required."];
      continue;
    }
    if (v === null) {
      if ((f as any).nullable) { out[k] = null; continue; }
      errors[k] = ["This field may not be null."];
      continue;
    }
    switch (f.type) {
      case "str":
      case "email": {
        v = String(v).trim();
        if (v === "") {
          if (f.blank) { out[k] = (f as any).nullable && f.type === "str" ? v : v; continue; }
          errors[k] = ["This field may not be blank."];
          continue;
        }
        if (f.max && v.length > f.max) { errors[k] = [`Ensure this field has no more than ${f.max} characters.`]; continue; }
        if (f.type === "email" && !EMAIL_RE.test(v)) { errors[k] = ["Enter a valid email address."]; continue; }
        out[k] = v;
        break;
      }
      case "bool":
        if (TRUE.has(v)) out[k] = true;
        else if (FALSE.has(v)) out[k] = false;
        else errors[k] = ["Must be a valid boolean."];
        break;
      case "date": {
        const s = String(v).trim();
        const d = new Date(s + "T00:00:00Z");
        if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) {
          errors[k] = ["Date has wrong format. Use one of these formats instead: YYYY-MM-DD."];
        } else out[k] = s;
        break;
      }
      case "choice":
        if (!f.choices.includes(String(v))) errors[k] = [`"${v}" is not a valid choice.`];
        else out[k] = String(v);
        break;
    }
  }
  if (Object.keys(errors).length) throw bad(errors);
  return out;
}
