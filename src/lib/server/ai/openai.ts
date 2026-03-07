import OpenAI from "openai";

let client: OpenAI | null = null;

export function getOpenAI() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;
  if (!client) client = new OpenAI({ apiKey });
  return client;
}

export function isAIEnabled() {
  return String(process.env.AI_ENABLED || "false").toLowerCase() === "true" && !!process.env.OPENAI_API_KEY;
}
