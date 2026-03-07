import { getOpenAI, isAIEnabled } from "./openai";

export async function explainReview(payload: Record<string, any>) {
  if (!isAIEnabled()) return { explanation: "AI disabled", nextAction: "Uzupełnij OPENAI_API_KEY, aby włączyć wyjaśnienia.", confidence: 0.1 };
  const client = getOpenAI();
  if (!client) return { explanation: "AI disabled", nextAction: "Uzupełnij OPENAI_API_KEY, aby włączyć wyjaśnienia.", confidence: 0.1 };

  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL_SMART || "gpt-5.4",
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text:
          "Wyjaśnij księgowej prostym językiem dlaczego rekord trafił do review queue. " +
          "Zwróć tylko JSON: {explanation:string, nextAction:string, confidence:number}."
        }]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: JSON.stringify(payload) }]
      }
    ]
  });

  try {
    return JSON.parse(response.output_text || "{}");
  } catch {
    return { explanation: response.output_text || "Brak wyjaśnienia", nextAction: "Sprawdź ręcznie rekord.", confidence: 0.4 };
  }
}
