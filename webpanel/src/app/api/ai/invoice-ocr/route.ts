import { NextResponse } from "next/server";
import { getAdminDb } from "@/lib/server/firebaseAdmin";
import { analyzeInvoiceImage, analyzeInvoicePdf, analyzeInvoiceText, extractPdfText } from "@/lib/server/ai/ocr";

export const runtime = "nodejs";

export async function POST(req: Request) {
  try {
    const form = await req.formData();
    const file = form.get("file");
    const communityId = String(form.get("communityId") || "").trim();
    if (!communityId) return NextResponse.json({ error: "Missing communityId" }, { status: 400 });
    if (!(file instanceof File)) return NextResponse.json({ error: "Brak pliku faktury." }, { status: 400 });

    const buffer = Buffer.from(await file.arrayBuffer());
    const mimeType = String(file.type || "application/octet-stream");
    const filename = String((file as any).name || "invoice");
    const adminDb = getAdminDb();
    const flatsSnap = await adminDb.collection(`communities/${communityId}/flats`).limit(500).get();
    const knownBuildings = Array.from(new Set(flatsSnap.docs.map((d) => String(d.get("buildingId") || d.get("buildingNo") || "")).filter(Boolean)));
    const knownFlats = flatsSnap.docs.slice(0, 300).map((d) => ({
      id: d.id,
      flatLabel: d.get("flatLabel") || `${d.get("street") || d.get("streetName") || ""} ${d.get("buildingNo") || ""}/${d.get("apartmentNo") || d.get("flatNumber") || ""}`.trim(),
      street: d.get("street") || d.get("streetName") || "",
      streetId: d.get("streetId") || "",
      buildingNo: d.get("buildingNo") || "",
      apartmentNo: d.get("apartmentNo") || d.get("flatNumber") || "",
    }));

    if (mimeType === "application/pdf") {
      const textLayer = await extractPdfText(buffer);
      const hasTextLayer = textLayer.replace(/\s+/g, " ").trim().length >= 30;
      let result = hasTextLayer
        ? await analyzeInvoiceText({ extractedText: [textLayer, filename].filter(Boolean).join("\n"), knownBuildings, knownFlats })
        : await analyzeInvoicePdf({ filename, mimeType, buffer, extractedText: filename, knownBuildings, knownFlats });

      if ((!result.extractedText || result.extractedText.trim().length < 20 || result.allocationType === "UNKNOWN") && hasTextLayer) {
        const fallback = await analyzeInvoicePdf({ filename, mimeType, buffer, extractedText: [textLayer, filename].filter(Boolean).join("\n"), knownBuildings, knownFlats });
        if ((fallback.confidence || 0) >= (result.confidence || 0)) {
          result = { ...fallback, extractedText: fallback.extractedText || textLayer } as any;
        }
      }

      if (!result.extractedText && !hasTextLayer) {
        return NextResponse.json({ error: "Nie udało się odczytać PDF ani warstwy tekstowej, ani fallback OCR/AI." }, { status: 422 });
      }

      return NextResponse.json({ ok: true, filename, pipeline: hasTextLayer ? "pdf-text-layer->ai-extraction" : "pdf-file-fallback-ocr->ai-extraction", ...result });
    }

    if (mimeType.startsWith("image/")) {
      const ai = await analyzeInvoiceImage({ mimeType, buffer, knownBuildings, knownFlats });
      return NextResponse.json({ ok: true, filename, pipeline: "image-ocr->ai-extraction", ...ai });
    }

    return NextResponse.json({ error: "Obsługiwane są tylko PDF, JPG, JPEG, PNG i WEBP." }, { status: 400 });
  } catch (error: any) {
    return NextResponse.json({ error: error?.message || "OCR error" }, { status: 500 });
  }
}
