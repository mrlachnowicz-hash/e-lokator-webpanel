export function normalizeStreetId(name: string) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function displayStreetName(street?: string, streetId?: string, byId?: Map<string, string> | Record<string, string>) {
  const direct = String(street || "").trim();
  if (direct) return direct;
  const id = String(streetId || "").trim();
  if (!id) return "";
  const fromMap = byId instanceof Map ? byId.get(id) : byId?.[id];
  return String(fromMap || id).trim();
}
