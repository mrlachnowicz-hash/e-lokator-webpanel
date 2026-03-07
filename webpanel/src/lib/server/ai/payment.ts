import { getOpenAI, isAIEnabled } from "./openai";

export async function suggestPaymentMatch(payload: Record<string, any>) {
  if (!isAIEnabled()) return { flatId: null, settlementId: null, confidence: 0.1, reason: "AI disabled", needsReview: true };
  const client = getOpenAI();
  if (!client) return { flatId: null, settlementId: null, confidence: 0.1, reason: "AI disabled", needsReview: true };

  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL_FAST || "gpt-5-mini",
    input: [
      { role: "system", content: [{ type: "input_text", text:
        "Dopasowujesz przelew do lokalu i rozliczenia. Zwróć tylko JSON: {flatId:string|null, settlementId:string|null, confidence:number, reason:string, needsReview:boolean}." }] },
      { role: "user", content: [{ type: "input_text", text: JSON.stringify(payload) }] }
    ]
  });

  try { return JSON.parse(response.output_text || "{}"); } catch { return { flatId: null, settlementId: null, confidence: 0.2, reason: response.output_text || "No parse", needsReview: true }; }
}
