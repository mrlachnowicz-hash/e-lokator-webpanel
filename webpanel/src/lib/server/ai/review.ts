import { getOpenAI, isAIEnabled } from "./openai";
import { safeParseJson } from "./json";

const FALLBACK = { explanation: "AI disabled", nextAction: "Uzupełnij OPENAI_API_KEY, aby włączyć wyjaśnienia.", confidence: 0.1 };

export async function explainReview(payload: Record<string, any>) {
  if (!isAIEnabled()) return FALLBACK;
  const client = getOpenAI();
  if (!client) return FALLBACK;

  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL_SMART || "gpt-5.4",
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text:
          "Wyjaśnij księgowej prostym językiem dlaczego rekord trafił do review queue. Zwróć tylko JSON: {explanation:string, nextAction:string, confidence:number}."
        }]
      },
      { role: "user", content: [{ type: "input_text", text: JSON.stringify(payload) }] }
    ]
  });

  return safeParseJson(response.output_text || "", FALLBACK);
}
