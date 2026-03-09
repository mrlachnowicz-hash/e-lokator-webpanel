export function normalizePlain(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function shortHash(input: string) {
  let hash = 0;
  const src = String(input || "X");
  for (let i = 0; i < src.length; i += 1) hash = ((hash << 5) - hash + src.charCodeAt(i)) | 0;
  return Math.abs(hash).toString(36).toUpperCase().padStart(6, "0").slice(0, 6);
}

export function buildStablePaymentTitle(input: { communityId?: string; flatId?: string; street?: string; buildingNo?: string; apartmentNo?: string; flatLabel?: string; period?: string; }) {
  const period = String(input.period || "").replace(/[^0-9]/g, "").slice(2, 6) || "0000";
  const localPart = normalizePlain(input.apartmentNo || input.flatLabel || input.flatId || "L").slice(-4) || "L";
  const seed = [input.communityId || "", input.flatId || "", input.street || "", input.buildingNo || "", input.apartmentNo || "", input.period || ""].join("|");
  return `EL${period}${localPart}${shortHash(seed)}`.slice(0, 18);
}

export function normalizeAccountNumber(value: unknown) {
  return String(value ?? "").replace(/\D/g, "");
}
