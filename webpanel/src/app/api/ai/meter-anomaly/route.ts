import { NextResponse } from "next/server";
import { detectMeterAnomaly } from "@/lib/server/ai/meter";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const body = await req.json();
    const result = await detectMeterAnomaly(body || {});
    return NextResponse.json({ ok: true, ...result });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "AI meter error" }, { status: 500 });
  }
}
