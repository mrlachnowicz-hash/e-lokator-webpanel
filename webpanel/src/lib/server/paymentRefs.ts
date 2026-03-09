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
  const period = String(input.period || "0000-00").match(/^(\d{4}-\d{2})/)?.[1] || "0000-00";
  const seed = [input.communityId || "COMM", input.flatId || "", input.street || "", input.buildingNo || "", input.apartmentNo || "", input.flatLabel || "", period].join("|");
  const partA = randomTripletFromSeed(seed, "A");
  const partB = randomTripletFromSeed(seed, "B");
  const partC = randomTripletFromSeed(seed, "C");
  return `EL-${partA}-${partB}-${partC}-${period}`;
}

export function normalizeAccountNumber(value: unknown) {
  return String(value ?? "").replace(/\D/g, "");
}
