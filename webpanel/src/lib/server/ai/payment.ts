import { getOpenAI, isAIEnabled } from "./openai";
import { safeParseJson } from "./json";

const FALLBACK = { flatId: null, settlementId: null, confidence: 0.1, reason: "AI disabled", needsReview: true };

export async function suggestPaymentMatch(payload: Record<string, any>) {
  if (!isAIEnabled()) return FALLBACK;
  const client = getOpenAI();
  if (!client) return FALLBACK;

  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL_FAST || "gpt-5-mini",
    input: [
      {
        role: "system",
        content: [{
          type: "input_text",
          text:
            "Dopasowujesz przelew do lokalu i rozliczenia. Zwróć tylko JSON: {flatId:string|null, settlementId:string|null, confidence:number, reason:string, needsReview:boolean}. " +
            "Nie zgaduj, jeśli nie ma podstaw. Wtedy needsReview=true."
        }]
      },
      { role: "user", content: [{ type: "input_text", text: JSON.stringify(payload) }] }
    ]
  });

  return safeParseJson(response.output_text || "", FALLBACK);
}
