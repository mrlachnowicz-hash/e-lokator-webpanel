import { NextResponse } from "next/server";
import { suggestPaymentMatch } from "@/lib/server/ai/payment";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const result = await suggestPaymentMatch(body || {});
    return NextResponse.json({ ok: true, ...result });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "AI payment error" }, { status: 500 });
  }
}
