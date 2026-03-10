import { getOpenAI, isAIEnabled } from "./openai";
import { safeParseJson } from "./json";
import { inferCostScope, matchInvoiceAddress, type FlatCandidate } from "@/lib/server/invoiceRecognition";

export type InvoiceOCRAllocationType = "COMMON" | "BUILDING" | "STAIRCASE" | "COMMUNITY" | "FLAT" | "UNKNOWN";

export type InvoiceOCRResult = {
  supplierName: string;
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  currency: string;
  grossAmount: number;
  netAmount: number;
  vatAmount: number;
  category: string;
  allocationType: InvoiceOCRAllocationType;
  suggestedBuildingId?: string;
  suggestedFlatId?: string;
  suggestedStreetId?: string;
  suggestedStreetName?: string;
  suggestedApartmentNo?: string;
  suggestedStaircaseId?: string;
  confidence: number;
  needsReview: boolean;
  reason: string;
  extractedText: string;
};

const FALLBACK: InvoiceOCRResult = {
  supplierName: "",
  invoiceNumber: "",
  issueDate: "",
  dueDate: "",
  currency: "PLN",
  grossAmount: 0,
  netAmount: 0,
  vatAmount: 0,
  category: "INNE",
  allocationType: "UNKNOWN",
  confidence: 0.2,
  needsReview: true,
  reason: "Nie udało się wiarygodnie odczytać faktury.",
  extractedText: "",
};

function aiPromptPayload(payload: {
  extractedText: string;
  knownBuildings?: string[];
  knownFlats?: Array<{ id: string; flatLabel?: string; street?: string; streetId?: string; buildingNo?: string; apartmentNo?: string }>;
}) {
  return JSON.stringify({
    knownBuildings: payload.knownBuildings || [],
    knownFlats: payload.knownFlats || [],
    extractedText: String(payload.extractedText || "").slice(0, 120000),
  });
}

function normalizeAmount(value: string) {
  const cleaned = String(value || "")
    .replace(/PLN|zł|zl|EUR/gi, "")
    .replace(/\s/g, "")
    .replace(/\.(?=\d{3}(\D|$))/g, "")
    .replace(/,(?=\d{2}(\D|$))/g, ".");
  const num = Number(cleaned.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(num) ? num : 0;
}

function normalizeLine(value: string) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function heuristicCategory(text: string) {
  const t = normalizeLine(text);
  if (t.includes("energia") || t.includes("tauron") || t.includes("prad") || t.includes("elektry")) return "PRĄD";
  if (t.includes("woda") || t.includes("sciek") || t.includes("wodociag")) return "WODA";
  if (t.includes("gaz")) return "GAZ";
  if (t.includes("sprzatan")) return "SPRZĄTANIE";
  if (t.includes("remont") || t.includes("malowan") || t.includes("napraw") || t.includes("hydraul") || t.includes("elektryk") || t.includes("szklar") || t.includes("serwis")) return "REMONT";
  return "INNE";
}

function parseBasicInvoiceText(text: string, knownBuildings?: string[], knownFlats?: FlatCandidate[]): Partial<InvoiceOCRResult> {
  const raw = String(text || "").replace(/\u0000/g, " ").trim();
  const lines = raw.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
  const compact = lines.join("\n");
  const compactNorm = normalizeLine(compact);
  const invoiceNumber = (compact.match(/(?:numer faktury|nr faktury|faktura\s+nr|fv\/?[a-z]*)\s*[:#-]?\s*([A-Z0-9\/-]+)/i)?.[1] || "").trim();
  const issueDate = (compact.match(/(?:data wystawienia|issue date)\s*[:#-]?\s*(20\d{2}[-./]\d{2}[-./]\d{2})/i)?.[1] || "").replace(/\./g, "-").replace(/\//g, "-");
  const dueDate = (compact.match(/(?:termin płatności|termin platnosci|due date)\s*[:#-]?\s*(20\d{2}[-./]\d{2}[-./]\d{2})/i)?.[1] || "").replace(/\./g, "-").replace(/\//g, "-");
  let supplierName = "";
  const sellerIdx = lines.findIndex((x) => /sprzedawca|seller/i.test(x));
  if (sellerIdx >= 0 && lines[sellerIdx + 1]) supplierName = lines[sellerIdx + 1] || "";
  if (!supplierName) supplierName = (compact.match(/(?:sprzedawca|seller)\s*[:#-]?\s*([^\n]+)/i)?.[1] || "").trim();
  if (!supplierName) supplierName = lines.find((x) => /sp\.? z o\.o\.|s\.a\.|tauron|wodociągi|wodociagi|gaz|serwis|usługi|uslugi|hydro|volt|glass|kolor/i.test(x)) || "";
  const amountMatch = compact.match(/(?:do zapłaty|do zaplaty|razem brutto|kwota brutto|wartość brutto|wartosc brutto|total)\s*[:#-]?\s*([0-9\s.,]+)\s*(PLN|zł|zl|EUR)?/i);
  const grossAmount = amountMatch ? normalizeAmount(`${amountMatch[1]} ${amountMatch[2] || ""}`) : 0;
  const category = heuristicCategory(compact);
  const scopeHint = inferCostScope(compact);
  let allocationType: InvoiceOCRResult["allocationType"] = scopeHint.scope;
  let suggestedBuildingId = "";
  for (const building of knownBuildings || []) {
    if (!building) continue;
    const b = normalizeLine(building);
    if ((b && compactNorm.includes(` ${b}`)) || compactNorm.includes(`/${b}`) || compactNorm.includes(`${b}/`)) {
      suggestedBuildingId = building;
      break;
    }
  }
  const addressMatch = matchInvoiceAddress(compact, knownFlats || []);
  if (addressMatch?.flatId) {
    if (allocationType === "UNKNOWN" || allocationType === "FLAT") {
      allocationType = "FLAT";
    } else if (allocationType === "BUILDING" && /lokal|mieszkanie|adres lokalu|nr lokalu/.test(compactNorm)) {
      allocationType = "FLAT";
    }
  } else if (allocationType === "UNKNOWN" && suggestedBuildingId) {
    allocationType = "BUILDING";
  }
  const confidence = Math.max(0.35, Math.min(0.97,
    (invoiceNumber ? 0.18 : 0) +
    (supplierName ? 0.12 : 0) +
    (grossAmount > 0 ? 0.2 : 0) +
    (issueDate ? 0.08 : 0) +
    (allocationType !== "UNKNOWN" ? 0.12 : 0) +
    (suggestedBuildingId ? 0.08 : 0) +
    (addressMatch?.confidence || 0) * 0.35 +
    (scopeHint.confidence || 0) * 0.12,
  ));
  const reasons = [scopeHint.reason, addressMatch?.reason].filter(Boolean).join("; ");
  return {
    supplierName,
    invoiceNumber,
    issueDate,
    dueDate,
    grossAmount,
    netAmount: 0,
    vatAmount: 0,
    category,
    allocationType,
    suggestedBuildingId: addressMatch?.buildingNo || suggestedBuildingId,
    suggestedFlatId: addressMatch?.flatId || "",
    suggestedStreetId: addressMatch?.streetId || "",
    suggestedStreetName: addressMatch?.streetName || "",
    suggestedApartmentNo: addressMatch?.apartmentNo || "",
    suggestedStaircaseId: "",
    confidence,
    needsReview: confidence < 0.88 || allocationType === "UNKNOWN" || grossAmount <= 0,
    reason: reasons || (confidence >= 0.88 ? "Dane odczytane automatycznie z dokumentu." : "Dane odczytane częściowo automatycznie. Wymagają sprawdzenia."),
    extractedText: raw,
  };
}

function mergeWithHeuristic(parsed: Partial<InvoiceOCRResult>, heuristic: Partial<InvoiceOCRResult>, extractedText: string, fallbackReason?: string): InvoiceOCRResult {
  const confidence = Number(parsed?.confidence ?? heuristic?.confidence ?? 0);
  const allocationType = parsed?.allocationType || heuristic?.allocationType || FALLBACK.allocationType;
  const grossAmount = Number(parsed?.grossAmount ?? heuristic?.grossAmount ?? 0);
  return {
    ...FALLBACK,
    ...heuristic,
    ...parsed,
    supplierName: String(parsed?.supplierName || heuristic?.supplierName || ""),
    invoiceNumber: String(parsed?.invoiceNumber || heuristic?.invoiceNumber || ""),
    issueDate: String(parsed?.issueDate || heuristic?.issueDate || ""),
    dueDate: String(parsed?.dueDate || heuristic?.dueDate || ""),
    currency: String(parsed?.currency || heuristic?.currency || "PLN"),
    category: String(parsed?.category || heuristic?.category || FALLBACK.category),
    allocationType,
    suggestedBuildingId: String(parsed?.suggestedBuildingId || heuristic?.suggestedBuildingId || ""),
    suggestedFlatId: String(parsed?.suggestedFlatId || heuristic?.suggestedFlatId || ""),
    suggestedStreetId: String((parsed as any)?.suggestedStreetId || (heuristic as any)?.suggestedStreetId || ""),
    suggestedStreetName: String((parsed as any)?.suggestedStreetName || (heuristic as any)?.suggestedStreetName || ""),
    suggestedApartmentNo: String((parsed as any)?.suggestedApartmentNo || (heuristic as any)?.suggestedApartmentNo || ""),
    suggestedStaircaseId: String((parsed as any)?.suggestedStaircaseId || (heuristic as any)?.suggestedStaircaseId || ""),
    grossAmount,
    netAmount: Number(parsed?.netAmount || heuristic?.netAmount || 0),
    vatAmount: Number(parsed?.vatAmount || heuristic?.vatAmount || 0),
    confidence,
    needsReview: Boolean(parsed?.needsReview ?? heuristic?.needsReview ?? (confidence < 0.88 || allocationType === "UNKNOWN" || grossAmount <= 0)),
    reason: String(parsed?.reason || heuristic?.reason || fallbackReason || FALLBACK.reason),
    extractedText,
  };
}

async function askAi(input: any[]) {
  const client = getOpenAI();
  if (!client) return null;
  return client.responses.create({ model: process.env.OPENAI_MODEL_SMART || process.env.OPENAI_MODEL_FAST || "gpt-5.4", input } as any);
}

async function askAiWithDocument(file: { filename: string; mimeType: string; buffer: Buffer }, promptText: string) {
  const client = getOpenAI();
  if (!client) return null;
  const dataUrl = `data:${file.mimeType};base64,${file.buffer.toString("base64")}`;
  return client.responses.create({
    model: process.env.OPENAI_MODEL_SMART || process.env.OPENAI_MODEL_FAST || "gpt-5.4",
    input: [
      { role: "system", content: [{ type: "input_text", text: promptText }] },
      { role: "user", content: [{ type: "input_file", filename: file.filename, file_data: dataUrl }] },
    ],
  } as any);
}

export async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const pdfParse = (await import("pdf-parse")).default as any;
    const parsed = await pdfParse(buffer);
    return String(parsed?.text || "").replace(/\u0000/g, " ").trim();
  } catch {
    return "";
  }
}

const INVOICE_SYSTEM_PROMPT = "Jesteś systemem OCR/analizy faktur dla wspólnot mieszkaniowych. Zwróć wyłącznie JSON bez markdown. Schema: {supplierName:string, invoiceNumber:string, issueDate:string, dueDate:string, currency:string, grossAmount:number, netAmount:number, vatAmount:number, category:string, allocationType:'COMMON'|'BUILDING'|'STAIRCASE'|'COMMUNITY'|'FLAT'|'UNKNOWN', suggestedBuildingId?:string, suggestedFlatId?:string, suggestedStreetId?:string, suggestedStreetName?:string, suggestedApartmentNo?:string, suggestedStaircaseId?:string, confidence:number, needsReview:boolean, reason:string, extractedText?:string}. Jeżeli brak pewności, ustaw needsReview=true i allocationType='UNKNOWN'. Nie przypisuj lokalu ani budynku na siłę.";

export async function analyzeInvoiceText(payload: {
  extractedText: string;
  knownBuildings?: string[];
  knownFlats?: Array<{ id: string; flatLabel?: string; street?: string; streetId?: string; buildingNo?: string; apartmentNo?: string }>;
}) {
  const text = String(payload.extractedText || "").trim();
  if (!text) return FALLBACK;
  const heuristic = parseBasicInvoiceText(text, payload.knownBuildings, payload.knownFlats as FlatCandidate[]);
  if (!isAIEnabled()) return mergeWithHeuristic({}, heuristic, text, "Odczytano dokument regułami lokalnymi bez AI.");
  const response = await askAi([
    { role: "system", content: [{ type: "input_text", text: INVOICE_SYSTEM_PROMPT }] },
    { role: "user", content: [{ type: "input_text", text: aiPromptPayload(payload) }] },
  ]);
  const parsed = safeParseJson<Partial<InvoiceOCRResult>>(response?.output_text || "", {});
  return mergeWithHeuristic(parsed, heuristic, text, "AI nie zwróciło poprawnego JSON.");
}

export async function analyzeInvoicePdf(payload: {
  filename: string;
  mimeType: string;
  buffer: Buffer;
  extractedText: string;
  knownBuildings?: string[];
  knownFlats?: Array<{ id: string; flatLabel?: string; street?: string; streetId?: string; buildingNo?: string; apartmentNo?: string }>;
}) {
  const baseText = [payload.extractedText, payload.filename].filter(Boolean).join("\n").trim();
  const heuristic = parseBasicInvoiceText(baseText, payload.knownBuildings, payload.knownFlats as FlatCandidate[]);
  if (!isAIEnabled()) return mergeWithHeuristic({}, heuristic, baseText, "PDF odczytano regułami lokalnymi bez AI.");
  try {
    const response = await askAiWithDocument(
      { filename: payload.filename, mimeType: payload.mimeType, buffer: payload.buffer },
      `${INVOICE_SYSTEM_PROMPT} Dodatkowy kontekst znanych budynków/lokali: ${aiPromptPayload({ extractedText: payload.extractedText, knownBuildings: payload.knownBuildings, knownFlats: payload.knownFlats })}`,
    );
    const parsed = safeParseJson<Partial<InvoiceOCRResult>>(response?.output_text || "", {});
    const extracted = String((parsed as any)?.extractedText || payload.extractedText || "").trim();
    return mergeWithHeuristic(parsed, parseBasicInvoiceText(extracted || baseText, payload.knownBuildings, payload.knownFlats as FlatCandidate[]), extracted || baseText, "AI nie zwróciło poprawnego OCR PDF.");
  } catch {
    return mergeWithHeuristic({}, heuristic, baseText, "AI OCR PDF nie zadziałało, użyto tekstu wyciągniętego z PDF.");
  }
}

export async function analyzeInvoiceImage(payload: {
  mimeType: string;
  buffer: Buffer;
  knownBuildings?: string[];
  knownFlats?: Array<{ id: string; flatLabel?: string; street?: string; streetId?: string; buildingNo?: string; apartmentNo?: string }>;
}) {
  if (!isAIEnabled()) return { ...FALLBACK, reason: "AI wyłączone. OCR obrazu nie jest dostępny." };
  const base64 = payload.buffer.toString("base64");
  const dataUrl = `data:${payload.mimeType};base64,${base64}`;
  const response = await askAi([
    { role: "system", content: [{ type: "input_text", text: INVOICE_SYSTEM_PROMPT }] },
    {
      role: "user",
      content: [
        { type: "input_text", text: aiPromptPayload({ extractedText: "OCR z obrazu", knownBuildings: payload.knownBuildings, knownFlats: payload.knownFlats }) },
        { type: "input_image", image_url: dataUrl },
      ],
    },
  ]);
  const parsed = safeParseJson<Partial<InvoiceOCRResult>>(response?.output_text || "", FALLBACK);
  const extracted = String((parsed as any)?.extractedText || "OCR z obrazu");
  const heuristic = parseBasicInvoiceText(extracted, payload.knownBuildings, payload.knownFlats as FlatCandidate[]);
  return mergeWithHeuristic(parsed, heuristic, extracted, "AI nie zwróciło poprawnego OCR obrazu.");
}
