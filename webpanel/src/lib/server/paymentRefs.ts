import crypto from "crypto";

export function normalizePlain(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function shortHash(input: string) {
  return crypto.createHash("sha256").update(String(input || "X")).digest("hex").toUpperCase().slice(0, 6);
}

function randomTripletFromSeed(seed: string, salt: string) {
  const hex = crypto.createHash("sha256").update(`${salt}|${seed}`).digest("hex");
  const num = parseInt(hex.slice(0, 8), 16) % 1000;
  return String(num).padStart(3, "0");
}

export function buildStablePaymentTitle(input: { communityId?: string; flatId?: string; street?: string; buildingNo?: string; apartmentNo?: string; flatLabel?: string; period?: string; }) {
  const apartmentPart = normalizePlain(input.apartmentNo || input.flatLabel || input.flatId || "0").slice(-3).padStart(3, "0");
  const period = String(input.period || "0000-00").match(/^(\d{4}-\d{2})/)?.[1] || "0000-00";
  const seed = [input.communityId || "COMM", input.flatId || "", input.street || "", input.buildingNo || "", input.apartmentNo || "", period].join("|");
  const randA = randomTripletFromSeed(seed, "A");
  const randB = randomTripletFromSeed(seed, "B");
  return `EL-${apartmentPart}-${randA}-${randB}-${period}`;
}

export function normalizeAccountNumber(value: unknown) {
  return String(value ?? "").replace(/\D/g, "");
}
