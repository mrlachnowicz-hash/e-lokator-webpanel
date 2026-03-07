import { getOpenAI, isAIEnabled } from "./openai";

export async function detectMeterAnomaly(payload: Record<string, any>) {
  if (!isAIEnabled()) return { anomaly: false, confidence: 0.1, reason: "AI disabled" };
  const client = getOpenAI();
  if (!client) return { anomaly: false, confidence: 0.1, reason: "AI disabled" };

  const response = await client.responses.create({
    model: process.env.OPENAI_MODEL_FAST || "gpt-5-mini",
    input: [
      { role: "system", content: [{ type: "input_text", text:
        "Oceń czy odczyt licznika wygląda podejrzanie. Zwróć tylko JSON: {anomaly:boolean, confidence:number, reason:string}." }] },
      { role: "user", content: [{ type: "input_text", text: JSON.stringify(payload) }] }
    ]
  });

  try { return JSON.parse(response.output_text || "{}"); } catch { return { anomaly: false, confidence: 0.2, reason: response.output_text || "No parse" }; }
}
