import { getOpenAI, isAIEnabled } from "./openai";
import { safeParseJson } from "./json";

const FALLBACK = { anomaly: false, confidence: 0.1, reason: "AI disabled" };

export async function detectMeterAnomaly(payload: Record<string, any>) {
  if (!isAIEnabled()) return FALLBACK;
  const client = getOpenAI();
  if (!client) return FALLBACK;

  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL_FAST || "gpt-5-mini",
    input: [
      { role: "system", content: [{ type: "input_text", text:
        "Oceń czy odczyt licznika wygląda podejrzanie. Zwróć tylko JSON: {anomaly:boolean, confidence:number, reason:string}." }] },
      { role: "user", content: [{ type: "input_text", text: JSON.stringify(payload) }] }
    ]
  });

  return safeParseJson(response.output_text || "", FALLBACK);
}
