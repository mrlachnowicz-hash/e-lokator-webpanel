import { getOpenAI, isAIEnabled } from "./openai";
import { safeParseJson } from "./json";

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
  allocationType: "COMMON" | "BUILDING" | "FLAT" | "UNKNOWN";
  suggestedBuildingId?: string;
  suggestedFlatId?: string;
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

export async function extractPdfText(buffer: Buffer): Promise<string> {
  try {
    const pdfParse = (await import("pdf-parse")).default as any;
    const parsed = await pdfParse(buffer);
    return String(parsed?.text || "").replace(/\u0000/g, " ").trim();
  } catch {
    return "";
  }
}

export async function analyzeInvoiceText(payload: {
  extractedText: string;
  knownBuildings?: string[];
  knownFlats?: Array<{ id: string; flatLabel?: string }>;
}) {
  const text = String(payload.extractedText || "").trim();
  if (!text) return FALLBACK;
  if (!isAIEnabled()) return { ...FALLBACK, extractedText: text, reason: "AI wyłączone. Dodano tylko tekst z PDF." };
  const client = getOpenAI();
  if (!client) return { ...FALLBACK, extractedText: text, reason: "Brak OPENAI_API_KEY." };

  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL_SMART || process.env.OPENAI_MODEL_FAST || "gpt-5.4",
    input: [
      {
        role: "system",
        content: [{
          type: "input_text",
          text:
            "Jesteś systemem OCR/analizy faktur dla wspólnot mieszkaniowych. " +
            "Zwróć wyłącznie JSON bez markdown. " +
            "Schema: {supplierName:string, invoiceNumber:string, issueDate:string, dueDate:string, currency:string, grossAmount:number, netAmount:number, vatAmount:number, category:string, allocationType:'COMMON'|'BUILDING'|'FLAT'|'UNKNOWN', suggestedBuildingId?:string, suggestedFlatId?:string, confidence:number, needsReview:boolean, reason:string}. " +
            "Jeżeli brak pewności, ustaw needsReview=true i allocationType='UNKNOWN'. " +
            "Nie wymyślaj identyfikatorów nieobecnych w danych wejściowych."
        }]
      },
      {
        role: "user",
        content: [{
          type: "input_text",
          text: JSON.stringify({
            knownBuildings: payload.knownBuildings || [],
            knownFlats: payload.knownFlats || [],
            extractedText: text.slice(0, 120000),
          })
        }]
      }
    ]
  });

  const parsed = safeParseJson<Partial<InvoiceOCRResult>>(response.output_text || "", FALLBACK);
  return {
    ...FALLBACK,
    ...parsed,
    extractedText: text,
    grossAmount: Number((parsed as any)?.grossAmount || 0),
    netAmount: Number((parsed as any)?.netAmount || 0),
    vatAmount: Number((parsed as any)?.vatAmount || 0),
    confidence: Number((parsed as any)?.confidence || 0),
    needsReview: Boolean((parsed as any)?.needsReview ?? true),
  } satisfies InvoiceOCRResult;
}
