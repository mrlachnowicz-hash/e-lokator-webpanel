import crypto from "crypto";

export const PAYMENT_REF_PREFIX = "EL";
export const PAYMENT_REF_REGEX = /\b([A-Z]{2}-\d{3}-\d{3}-\d{3}-20\d{2}-\d{2})\b/i;

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

function randomTriplet() {
  return String(crypto.randomInt(0, 1000)).padStart(3, "0");
}

function randomTripletFromSeed(seed: string, salt: string) {
  const hex = crypto.createHash("sha256").update(`${salt}|${seed}`).digest("hex");
  const num = parseInt(hex.slice(0, 8), 16) % 1000;
  return String(num).padStart(3, "0");
}

export function isValidPaymentRef(value: unknown) {
  return PAYMENT_REF_REGEX.test(String(value ?? "").trim());
}

export function normalizePaymentRef(value: unknown) {
  const input = String(value ?? "").trim().toUpperCase();
  const match = input.match(PAYMENT_REF_REGEX);
  return match?.[1] || "";
}

export function extractPaymentRef(value: unknown) {
  const input = String(value ?? "").trim().toUpperCase().replace(/[–—]/g, "-");
  const direct = input.match(PAYMENT_REF_REGEX);
  if (direct?.[1]) return direct[1];
  const compact = input.replace(/[^A-Z0-9]/g, " ").replace(/\s+/g, " ").trim();
  const relaxed = compact.match(/\b([A-Z]{2})\s*(\d{3})\s*(\d{3})\s*(\d{3})\s*(20\d{2})\s*(\d{2})\b/);
  return relaxed ? `${relaxed[1]}-${relaxed[2]}-${relaxed[3]}-${relaxed[4]}-${relaxed[5]}-${relaxed[6]}` : "";
}

export function generatePaymentRef(period?: string, prefix = PAYMENT_REF_PREFIX) {
  const normalizedPrefix = normalizePlain(prefix).slice(0, 2).padEnd(2, "X");
  const periodLabel = String(period || new Date().toISOString().slice(0, 7)).match(/^(20\d{2})-(\d{2})/) || [];
  const year = periodLabel[1] || new Date().toISOString().slice(0, 4);
  const month = periodLabel[2] || new Date().toISOString().slice(5, 7);
  return `${normalizedPrefix}-${randomTriplet()}-${randomTriplet()}-${randomTriplet()}-${year}-${month}`;
}

export function buildStablePaymentTitle(input: { communityId?: string; flatId?: string; street?: string; buildingNo?: string; apartmentNo?: string; flatLabel?: string; period?: string; }) {
  const apartmentPart = normalizePlain(input.apartmentNo || input.flatLabel || input.flatId || "0").slice(-3).padStart(3, "0");
  const period = String(input.period || "0000-00").match(/^(\d{4}-\d{2})/)?.[1] || "0000-00";
  const seed = [input.communityId || "COMM", input.flatId || "", input.street || "", input.buildingNo || "", input.apartmentNo || "", period].join("|");
  const randA = randomTripletFromSeed(seed, "A");
  const randB = randomTripletFromSeed(seed, "B");
  return `${PAYMENT_REF_PREFIX}-${apartmentPart}-${randA}-${randB}-${period}`;
}

export function normalizeAccountNumber(value: unknown) {
  return String(value ?? "").replace(/\D/g, "");
}
