const DANGEROUS = /<script|javascript:|on\w+\s*=|<\s*iframe|<\s*object|<\s*embed/gi;

export function sanitizeInput(value: string): string {
  if (typeof value !== "string") return value;
  return value.replace(DANGEROUS, "").trim();
}

export function sanitizeObject<T extends Record<string, unknown>>(obj: T): T {
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj)) {
    if (typeof val === "string") {
      result[key] = sanitizeInput(val);
    } else if (val && typeof val === "object" && !Array.isArray(val)) {
      result[key] = sanitizeObject(val as Record<string, unknown>);
    } else {
      result[key] = val;
    }
  }
  return result as T;
}

export function explainSanitization(original: string, sanitized: string): string {
  if (original === sanitized) return "No changes — input is clean.";
  return `Sanitized ${original.length - sanitized.length} character(s): removed potentially dangerous content.`;
}
