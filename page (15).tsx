import { NextResponse } from "next/server";
import { explainReview } from "@/lib/server/ai/review";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const result = await explainReview(body || {});
    return NextResponse.json({ ok: true, ...result });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "AI review error" }, { status: 500 });
  }
}
