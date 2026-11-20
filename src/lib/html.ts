/** Minimal safe HTML templating: values are escaped unless wrapped with raw(). */
export class RawHtml {
  constructor(public readonly value: string) {}
  toString() {
    return this.value;
  }
}

export const raw = (v: string) => new RawHtml(v);

export function escapeHtml(v: unknown): string {
  return String(v ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

type Val = unknown;

function render(v: Val): string {
  if (v instanceof RawHtml) return v.value;
  if (Array.isArray(v)) return v.map(render).join("");
  if (v === null || v === undefined || v === false) return "";
  return escapeHtml(v);
}

export function html(strings: TemplateStringsArray, ...values: Val[]): RawHtml {
  let out = "";
  strings.forEach((s, i) => {
    out += s;
    if (i < values.length) out += render(values[i]);
  });
  return new RawHtml(out);
}
