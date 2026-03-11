import { getOpenAI, isAIEnabled } from "./openai";
import { safeJsonParse, type InvoiceAISuggestion } from "./schemas";

const FALLBACK: InvoiceAISuggestion = {
  category: "INNE",
  allocationType: "COMMON",
  confidence: 0.25,
  needsReview: true,
  reason: "AI disabled or no confident match",
};

export async function suggestInvoice(payload: Record<string, any>) {
  if (!isAIEnabled()) return FALLBACK;
  const client = getOpenAI();
  if (!client) return FALLBACK;

  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL_FAST || "gpt-5-mini",
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text:
          "Jesteś asystentem księgowym dla wspólnot mieszkaniowych. Zwracaj wyłącznie JSON bez markdown. " +
          "Schema: {category:string, allocationType:'COMMON'|'BUILDING'|'STAIRCASE'|'COMMUNITY'|'FLAT'|'UNKNOWN', suggestedBuildingId?:string, suggestedFlatId?:string, suggestedStreetId?:string, suggestedStreetName?:string, suggestedApartmentNo?:string, suggestedStaircaseId?:string, confidence:number, needsReview:boolean, reason:string}. " +
          "Jeżeli nie ma pewności, ustaw needsReview=true. Nie wymyślaj identyfikatorów jeśli nie ma ich w danych wejściowych."
        }]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: JSON.stringify(payload) }]
      }
    ]
  });

  return safeJsonParse<InvoiceAISuggestion>(response.output_text || "", FALLBACK);
}
