export function extractJsonObject(text: string) {
  const raw = String(text || "").trim();
  if (!raw) return "{}";
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start >= 0 && end > start) return raw.slice(start, end + 1);
  return raw;
}

export function safeParseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(extractJsonObject(text)) as T;
  } catch {
    return fallback;
  }
}
