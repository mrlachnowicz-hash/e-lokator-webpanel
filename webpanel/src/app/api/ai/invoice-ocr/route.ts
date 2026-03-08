import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/server/firebaseAdmin";
import { analyzeInvoiceImage, analyzeInvoiceText, extractPdfText } from "@/lib/server/ai/ocr";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const communityId = String(form.get("communityId") || "").trim();
    if (!communityId) return NextResponse.json({ error: "Missing communityId" }, { status: 400 });
    if (!(file instanceof File)) return NextResponse.json({ error: "Brak pliku faktury." }, { status: 400 });

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const mimeType = String(file.type || "application/octet-stream");
    const filename = String((file as any).name || "");
    const adminDb = getAdminDb();
    const flatsSnap = await adminDb.collection(`communities/${communityId}/flats`).limit(300).get();
    const knownBuildings = Array.from(new Set(flatsSnap.docs.map((d) => String(d.get("buildingId") || d.get("buildingNo") || "")).filter(Boolean)));
    const knownFlats = flatsSnap.docs.slice(0, 150).map((d) => ({ id: d.id, flatLabel: d.get("flatLabel") || `${d.get("street") || ""} ${d.get("buildingNo") || ""}/${d.get("apartmentNo") || ""}`.trim() }));

    if (mimeType === "application/pdf") {
      const extractedText = await extractPdfText(buffer);
      const seededText = [extractedText, filename].filter(Boolean).join("\n");
      const ai = await analyzeInvoiceText({ extractedText: seededText, knownBuildings, knownFlats });
      return NextResponse.json({ ok: true, ...ai });
    }

    if (mimeType.startsWith("image/")) {
      const ai = await analyzeInvoiceImage({ mimeType, buffer, knownBuildings, knownFlats });
      return NextResponse.json({ ok: true, ...ai });
    }

    return NextResponse.json({ error: "Obsługiwane są tylko PDF, JPG, JPEG, PNG i WEBP." }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "OCR error" }, { status: 500 });
  }
}
