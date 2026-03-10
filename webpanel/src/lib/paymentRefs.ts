export const PAYMENT_REF_PREFIX = "EL";
export const PAYMENT_REF_REGEX = /\b([A-Z]{2}-\d{3}-\d{3}-\d{3}-20\d{2}-\d{2})\b/i;

function normalizePeriod(period?: string) {
  const match = String(period || "").trim().match(/^(20\d{2})-(\d{2})/);
  if (match) return { year: match[1], month: match[2] };
  const now = new Date().toISOString().slice(0, 7).split("-");
  return { year: now[0] || "0000", month: now[1] || "00" };
}

function simpleHash(input: string) {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function tripletFromSeed(seed: string, salt: string) {
  return String(simpleHash(`${salt}|${seed}`) % 1000).padStart(3, "0");
}

export function normalizePlain(value: unknown) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
}

export function normalizeAccountNumber(value: unknown) {
  return String(value ?? "").replace(/\D/g, "");
}

export function isValidPaymentRef(value: unknown) {
  return PAYMENT_REF_REGEX.test(String(value ?? "").trim());
}

export function normalizePaymentRef(value: unknown) {
  const input = String(value ?? "").trim().toUpperCase().replace(/[–—]/g, "-");
  const direct = input.match(PAYMENT_REF_REGEX);
  if (direct?.[1]) return direct[1];
  const relaxed = input
    .replace(/[^A-Z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .match(/\b([A-Z]{2})\s*(\d{3})\s*(\d{3})\s*(\d{3})\s*(20\d{2})\s*(\d{2})\b/);
  return relaxed ? `${relaxed[1]}-${relaxed[2]}-${relaxed[3]}-${relaxed[4]}-${relaxed[5]}-${relaxed[6]}` : "";
}

export function extractPaymentRef(value: unknown) {
  return normalizePaymentRef(value);
}

export function shortHash(input: string) {
  return simpleHash(String(input || "X")).toString(16).toUpperCase().padStart(8, "0").slice(0, 6);
}

export type PaymentRefInput = {
  communityId?: string;
  flatId?: string;
  street?: string;
  buildingNo?: string;
  apartmentNo?: string;
  flatLabel?: string;
  period?: string;
};

function primaryTriplet(input: PaymentRefInput, seed: string) {
  const digits = normalizePlain(input.apartmentNo || input.flatId || input.flatLabel || "").replace(/[^0-9]/g, "");
  if (digits) return digits.slice(-3).padStart(3, "0");
  return tripletFromSeed(seed, "APT");
}

export function buildStablePaymentRef(input: PaymentRefInput) {
  const { year, month } = normalizePeriod(input.period);
  const seed = [
    input.communityId || "",
    input.flatId || "",
    input.street || "",
    input.buildingNo || "",
    input.apartmentNo || "",
    input.flatLabel || "",
    `${year}-${month}`,
  ].join("|");

  const part1 = primaryTriplet(input, seed);
  const part2 = tripletFromSeed(seed, "B");
  const part3 = tripletFromSeed(seed, "C");
  return `${PAYMENT_REF_PREFIX}-${part1}-${part2}-${part3}-${year}-${month}`;
}

export function buildStablePaymentTitle(input: PaymentRefInput) {
  return buildStablePaymentRef(input);
}

export function ensurePaymentRef(existingValue: unknown, input: PaymentRefInput) {
  return normalizePaymentRef(existingValue) || buildStablePaymentRef(input);
}

export function generatePaymentRef(period?: string, seed?: string) {
  const fallbackSeed = String(seed || `${period || ""}|${Date.now()}|${Math.random()}`);
  return buildStablePaymentRef({ period, flatId: fallbackSeed, flatLabel: fallbackSeed });
}
