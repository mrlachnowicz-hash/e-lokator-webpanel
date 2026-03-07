export function normalizePart(value: unknown) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9_-]/g, "");
}

export function buildFlatKey(communityId: string, street: unknown, buildingNo: unknown, apartmentNo: unknown) {
  return [communityId, street, buildingNo, apartmentNo].map(normalizePart).filter(Boolean).join("|");
}

export function buildFlatLabel(street: unknown, buildingNo: unknown, apartmentNo: unknown) {
  const left = [String(street ?? "").trim(), String(buildingNo ?? "").trim()].filter(Boolean).join(" ");
  const right = String(apartmentNo ?? "").trim();
  return [left, right].filter(Boolean).join("/").trim();
}

export function normalizeApartmentNo(value: unknown) {
  return String(value ?? "").trim();
}
