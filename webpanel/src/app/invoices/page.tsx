"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { addDoc, collection, deleteDoc, doc, onSnapshot, orderBy, query, updateDoc } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";
import { callable } from "../../lib/functions";
import { displayStreetName, normalizeStreetId } from "../../lib/streetUtils";

type Invoice = any;
type Flat = { id: string; street?: string; streetId?: string; streetName?: string; buildingNo?: string; apartmentNo?: string; flatLabel?: string };
type StreetOption = { id: string; name: string };
type OCRResult = {
  supplierName?: string; invoiceNumber?: string; issueDate?: string; dueDate?: string; currency?: string; grossAmount?: number;
  category?: string; allocationType?: "COMMON" | "BUILDING" | "FLAT" | "UNKNOWN"; suggestedBuildingId?: string; suggestedFlatId?: string;
  confidence?: number; needsReview?: boolean; reason?: string; extractedText?: string;
};

const formGridStyle: CSSProperties = { display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", alignItems: "stretch", minWidth: 0 };
const actionRowStyle: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center" };
const cardHeaderStyle: CSSProperties = { display: "flex", flexWrap: "wrap", gap: 12, alignItems: "center", minWidth: 0 };
const fieldStyle: CSSProperties = { width: "100%", minWidth: 0, boxSizing: "border-box" };
const fromCents = (cents: unknown) => (Number(cents || 0) / 100).toFixed(2);
const statusLabel = (value: unknown) => {
  switch (String(value || "").toUpperCase()) {
    case "NOWA": return "Nowa";
    case "SUGGESTED": return "Sugestia AI";
    case "READY_TO_STAGE": return "Gotowa do przeniesienia";
    case "STAGED": return "W szkicu";
    case "ZATWIERDZONA": return "Przeniesiona do szkicu";
    case "DELETED": return "Usunięta";
    default: return String(value || "—");
  }
};
const sourceLabel = (value: unknown) => {
  switch (String(value || "").toLowerCase()) {
    case "invoices": return "Faktury";
    case "ksefinvoices": return "KSeF";
    case "ocr_ai": return "OCR";
    default: return String(value || "—");
  }
};
const allocationLabel = (value: unknown) => {
  switch (String(value || "").toUpperCase()) {
    case "COMMON": return "Części wspólne";
    case "BUILDING": return "Budynek";
    case "FLAT": return "Konkretny lokal";
    case "UNKNOWN": return "Nieustalony";
    default: return String(value || "—");
  }
};
const categoryLabel = (value: unknown) => {
  switch (String(value || "").toUpperCase()) {
    case "PRAD": return "PRĄD";
    case "WODA": return "WODA";
    case "GAZ": return "GAZ";
    case "SPRZATANIE": return "SPRZĄTANIE";
    case "REMONT": return "REMONT";
    default: return String(value || "INNE");
  }
};

function flatLabel(flat: Flat) {
  return String(flat.flatLabel || `${flat.street || flat.streetName || ""} ${flat.buildingNo || ""}/${flat.apartmentNo || ""}`.trim());
}
function docCollectionName(inv: Invoice) { return inv._sourceCollection || "invoices"; }

export default function InvoicesPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [items, setItems] = useState<Invoice[]>([]);
  const [msg, setMsg] = useState("");
  const [ocrBusy, setOcrBusy] = useState(false);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [ocrResult, setOcrResult] = useState<OCRResult | null>(null);
  const [streets, setStreets] = useState<StreetOption[]>([]);
  const [flats, setFlats] = useState<Flat[]>([]);
  const [form, setForm] = useState({ vendorName: "", title: "", period: new Date().toISOString().slice(0, 7), totalGross: "", category: "INNE" });

  useEffect(() => {
    if (!communityId) return;
    let invItems: Invoice[] = [];
    let ksefItems: Invoice[] = [];
    const mergeItems = () => {
      const merged = [...invItems, ...ksefItems].sort((a, b) => Number(b.createdAtMs || 0) - Number(a.createdAtMs || 0));
      setItems(merged);
    };
    const unsubInv = onSnapshot(query(collection(db, "communities", communityId, "invoices"), orderBy("createdAtMs", "desc")), (snap) => {
      invItems = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any), _sourceCollection: "invoices" }));
      mergeItems();
    });
    const unsubKsef = onSnapshot(query(collection(db, "communities", communityId, "ksefInvoices"), orderBy("createdAtMs", "desc")), (snap) => {
      ksefItems = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any), _sourceCollection: "ksefInvoices" }));
      mergeItems();
    });
    const unsubStreets = onSnapshot(query(collection(db, "communities", communityId, "streets")), (snap) => {
      const list = snap.docs.map((d) => ({ id: d.id, name: String((d.data() as any).name || d.id), deletedAtMs: (d.data() as any).deletedAtMs })).filter((x: any) => !x.deletedAtMs);
      setStreets(list.sort((a, b) => a.name.localeCompare(b.name, "pl")));
    });
    const unsubFlats = onSnapshot(query(collection(db, "communities", communityId, "flats")), (snap) => {
      setFlats(snap.docs.map((d) => {
        const data: any = d.data() || {};
        return { id: d.id, ...data, apartmentNo: String(data.apartmentNo || data.flatNumber || "") };
      }));
    });
    return () => { unsubInv(); unsubKsef(); unsubStreets(); unsubFlats(); };
  }, [communityId]);

  const visibleItems = useMemo(() => items.filter((x) => !x.deletedAtMs && String(x.status || "").toUpperCase() !== "DELETED"), [items]);
  const stats = useMemo(() => ({
    total: visibleItems.filter((x) => !x.archivedAtMs).length,
    archived: visibleItems.filter((x) => !!x.archivedAtMs).length,
    staged: visibleItems.filter((x) => !x.archivedAtMs && (String(x.status || "").includes("STAGED") || String(x.status || "").includes("ZATWIERDZONA"))).length,
    review: visibleItems.filter((x) => !x.archivedAtMs && (x.ai?.suggestion?.needsReview || x.parsed?.needsReview)).length,
  }), [visibleItems]);

  async function handleDocument(file: File) {
    if (!communityId) return;
    setOcrBusy(true); setMsg("");
    try {
      const body = new FormData(); body.append("communityId", communityId); body.append("file", file);
      const res = await fetch("/api/ai/invoice-ocr", { method: "POST", body }); const data = await res.json();
      if (!res.ok) throw new Error(data.error || "OCR error");
      setOcrResult(data);
      setForm((prev) => ({ ...prev, vendorName: data.supplierName || prev.vendorName, title: data.invoiceNumber || prev.title, totalGross: data.grossAmount != null ? String(data.grossAmount) : prev.totalGross, category: data.category || prev.category }));
      setMsg(data.needsReview ? "Dokument został odczytany, ale wymaga sprawdzenia." : "Dokument został odczytany i przygotowano szkic.");
    } catch (error: any) {
      setMsg(error?.message || "Nie udało się odczytać dokumentu.");
    } finally { setOcrBusy(false); }
  }

  async function saveOcrDraft() {
    if (!communityId || !ocrResult) return;
    const period = form.period || new Date().toISOString().slice(0, 7);
    await addDoc(collection(db, "communities", communityId, "invoices"), {
      vendorName: ocrResult.supplierName || form.vendorName, title: ocrResult.invoiceNumber || form.title || "Faktura z OCR", period,
      category: ocrResult.category || form.category || "INNE", totalGrossCents: Math.round(Number(ocrResult.grossAmount || form.totalGross || 0) * 100),
      currency: ocrResult.currency || "PLN", source: "OCR_AI", status: ocrResult.needsReview ? "SUGGESTED" : "READY_TO_STAGE",
      parsed: { period, category: ocrResult.category || form.category || "INNE", scope: ocrResult.allocationType === "FLAT" ? "FLAT" : "COMMON", buildingId: ocrResult.suggestedBuildingId || "", flatId: ocrResult.suggestedFlatId || "", amountCents: Math.round(Number(ocrResult.grossAmount || form.totalGross || 0) * 100), totalGrossCents: Math.round(Number(ocrResult.grossAmount || form.totalGross || 0) * 100), needsReview: Boolean(ocrResult.needsReview), reason: ocrResult.reason || "", ocrText: ocrResult.extractedText || "" },
      ai: { suggestion: ocrResult, updatedAtMs: Date.now() }, createdAtMs: Date.now(), updatedAtMs: Date.now(),
    });
    setMsg("Dodano szkic faktury z OCR do panelu."); setOcrResult(null);
  }

  async function bulkAutoStage() {
    if (!communityId) return;
    const candidates = visibleItems.filter((x) => !x.archivedAtMs);
    if (candidates.length === 0) return;
    setBulkBusy(true);
    try {
      let processed = 0;
      let errors = 0;
      for (const inv of candidates) {
        try {
          const suggestion = inv.ai?.suggestion || inv.parsed || {};
          const scope = String(suggestion.scope || (suggestion.allocationType === "FLAT" ? "FLAT" : "COMMON") || "COMMON");
          let streetId = String(inv.parsed?.streetId || suggestion.streetId || "");
          if (!streetId && suggestion.suggestedFlatId) {
            const f = flats.find((x) => x.id === suggestion.suggestedFlatId);
            streetId = String(f?.streetId || normalizeStreetId(String(f?.street || f?.streetName || "")) || "");
          }
          const candidateFlats = flats.filter((f) => {
            const id = String(f.streetId || normalizeStreetId(String(f.street || f.streetName || "")) || "");
            return !streetId || id === streetId;
          });
          let buildingId = String(inv.parsed?.buildingId || suggestion.buildingId || suggestion.suggestedBuildingId || "");
          if (!buildingId && candidateFlats.length) buildingId = String(candidateFlats[0].buildingNo || "");
          let flatId = String(inv.parsed?.flatId || suggestion.flatId || suggestion.suggestedFlatId || "");
          if (scope === "FLAT" && !flatId) {
            const exact = candidateFlats.filter((f) => String(f.buildingNo || "") === buildingId);
            if (exact.length === 1) flatId = exact[0].id;
          }
          await callable("approveInvoice")({
            communityId,
            invoiceId: inv.id,
            assignment: {
              period: inv.parsed?.period || inv.period || form.period,
              category: inv.parsed?.category || inv.category || suggestion.category || "INNE",
              scope,
              streetId: streetId || null,
              buildingId: buildingId || null,
              flatId: scope === "FLAT" ? flatId || null : null,
            },
          });
          processed += 1;
        } catch {
          errors += 1;
        }
      }
      window.alert(`Automatyczne przenoszenie zakończone. Sukces: ${processed}, błędy: ${errors}.`);
    } finally {
      setBulkBusy(false);
    }
  }

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16, minWidth: 0 }}>
        <h2>Faktury</h2>
        <div className="card" style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          <div>Łącznie: <strong>{stats.total}</strong></div>
          <div>W szkicu: <strong>{stats.staged}</strong></div>
          <div>Do sprawdzenia: <strong>{stats.review}</strong></div>
          <div>Archiwum: <strong>{stats.archived}</strong></div>
        </div>
        <div className="card" style={{ display: "grid", gap: 12, minWidth: 0 }}>
          <h3>OCR faktury PDF / JPG / PNG</h3>
          <p style={{ opacity: 0.8, marginTop: -6 }}>Możesz wrzucić PDF albo obraz faktury. Wynik trafia jako szkic i nie księguje się sam bez kontroli.</p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
            <input type="file" accept="application/pdf,image/jpeg,image/jpg,image/png,image/webp" onChange={async (e) => {
              const file = e.target.files?.[0];
              if (file) await handleDocument(file);
            }} />
            <button className="btn" disabled={bulkBusy || visibleItems.length === 0} onClick={bulkAutoStage}>{bulkBusy ? "Przetwarzanie..." : "Rozlicz do szkicu automatycznie"}</button>
          </div>
          {ocrBusy ? <div>Analiza dokumentu...</div> : null}
          {ocrResult ? <div style={{ display: "grid", gap: 10 }}><div><strong>Dostawca:</strong> {ocrResult.supplierName || "—"}</div><div><strong>Numer faktury:</strong> {ocrResult.invoiceNumber || "—"}</div><div><strong>Kategoria:</strong> {categoryLabel(ocrResult.category || "—")}</div><div><strong>Typ alokacji:</strong> {allocationLabel(ocrResult.allocationType || "—")}</div><div><strong>Pewność odczytu:</strong> {Number(ocrResult.confidence || 0).toFixed(2)}</div><div><strong>Powód:</strong> {ocrResult.reason || "—"}</div><div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}><button className="btn" onClick={saveOcrDraft}>Zapisz szkic z OCR</button><button className="btnGhost" onClick={() => setOcrResult(null)}>Wyczyść</button></div><details><summary>Podgląd odczytanego tekstu</summary><pre style={{ whiteSpace: "pre-wrap", overflowX: "auto", margin: 0 }}>{ocrResult.extractedText || "Brak tekstu"}</pre></details></div> : null}
        </div>
        <div className="card" style={{ display: "grid", gap: 12, minWidth: 0 }}>
          <h3>Dodaj ręcznie</h3>
          <div style={formGridStyle}>
            <input className="input" style={fieldStyle} placeholder="Dostawca" value={form.vendorName} onChange={(e) => setForm({ ...form, vendorName: e.target.value })} />
            <input className="input" style={fieldStyle} placeholder="Tytuł" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <input className="input" style={fieldStyle} placeholder="YYYY-MM" value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })} />
            <input className="input" style={fieldStyle} placeholder="Kwota brutto" value={form.totalGross} onChange={(e) => setForm({ ...form, totalGross: e.target.value })} />
            <select className="select" style={fieldStyle} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}><option value="PRAD">PRĄD</option><option value="WODA">WODA</option><option value="GAZ">GAZ</option><option value="SPRZATANIE">SPRZĄTANIE</option><option value="REMONT">REMONT</option><option value="INNE">INNE</option></select>
          </div>
          <div style={actionRowStyle}><button className="btn" onClick={async () => { await addDoc(collection(db, "communities", communityId, "invoices"), { vendorName: form.vendorName, title: form.title, period: form.period, category: form.category, totalGrossCents: Math.round(Number((form.totalGross || "0").replace(",", ".")) * 100), currency: "PLN", status: "NOWA", source: "MANUAL", createdAtMs: Date.now(), updatedAtMs: Date.now() }); setForm({ ...form, vendorName: "", title: "", totalGross: "" }); }}>Dodaj fakturę</button><button className="btnGhost" onClick={async () => { await callable("ksefFetchInvoices")({ communityId, period: form.period }); setMsg("Pobrano faktury KSeF. Możesz teraz użyć przycisku: Rozlicz do szkicu automatycznie."); }}>Pobierz mock KSeF</button></div>
        </div>
        {msg ? <div style={{ color: "#8ef0c8", fontWeight: 700 }}>{msg}</div> : null}
        <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
          {visibleItems.filter((x) => !x.archivedAtMs).map((inv) => <InvoiceCard key={`${docCollectionName(inv)}-${inv.id}`} inv={inv} communityId={communityId} flats={flats} streets={streets} />)}
          {visibleItems.some((x) => !!x.archivedAtMs) ? <div className="card" style={{ marginTop: 8, display: "grid", gap: 10 }}><h3>Archiwum faktur</h3>{visibleItems.filter((x) => !!x.archivedAtMs).map((inv) => <InvoiceCard key={`${docCollectionName(inv)}-${inv.id}`} inv={inv} communityId={communityId} flats={flats} streets={streets} />)}</div> : null}
        </div>
      </div>
    </RequireAuth>
  );
}

function InvoiceCard({ inv, communityId, flats, streets }: { inv: Invoice; communityId: string; flats: Flat[]; streets: StreetOption[] }) {
  const [period, setPeriod] = useState(inv.parsed?.period || inv.period || new Date().toISOString().slice(0, 7));
  const [category, setCategory] = useState(inv.parsed?.category || inv.category || "INNE");
  const [scope, setScope] = useState(inv.parsed?.scope || (inv.ai?.suggestion?.allocationType === "FLAT" ? "FLAT" : "COMMON"));
  const [streetId, setStreetId] = useState(inv.parsed?.streetId || "");
  const [buildingNo, setBuildingNo] = useState(inv.parsed?.buildingId || inv.ai?.suggestion?.suggestedBuildingId || "");
  const [flatId, setFlatId] = useState(inv.parsed?.flatId || inv.ai?.suggestion?.suggestedFlatId || "");
  const [busy, setBusy] = useState(false);
  const amount = Number(inv.parsed?.amountCents || inv.totalGrossCents || inv.parsed?.totalGrossCents || 0);
  const ai = inv.ai?.suggestion;
  const showFlatId = scope === "FLAT";
  const streetMap = useMemo(() => new Map(streets.map((s) => [s.id, s.name])), [streets]);
  const streetOptions = useMemo(() => {
    const byId = new Map(streets.map((s) => [s.id, s]));
    flats.forEach((f) => {
      const id = String(f.streetId || normalizeStreetId(String(f.street || f.streetName || "")) || "");
      const name = displayStreetName(f.street || f.streetName, f.streetId, streetMap);
      if (id && name && !byId.has(id)) byId.set(id, { id, name });
    });
    return Array.from(byId.values()).sort((a, b) => a.name.localeCompare(b.name, "pl"));
  }, [flats, streets, streetMap]);
  const filteredFlatsByStreet = useMemo(() => flats.filter((f) => {
    const id = String(f.streetId || normalizeStreetId(String(f.street || f.streetName || "")) || "");
    const selectedName = displayStreetName("", streetId, streetMap).toLowerCase();
    return !streetId || id === streetId || String(f.street || f.streetName || "").toLowerCase() === selectedName;
  }), [flats, streetId, streetMap]);
  const buildingOptions = useMemo(() => Array.from(new Set(filteredFlatsByStreet.map((f) => String(f.buildingNo || "").trim()).filter(Boolean))).sort((a, b) => a.localeCompare(b, "pl", { numeric: true })), [filteredFlatsByStreet]);
  const flatOptions = useMemo(() => filteredFlatsByStreet.filter((f) => String(f.buildingNo || "").trim() === buildingNo), [filteredFlatsByStreet, buildingNo]);

  useEffect(() => {
    if (!streetId && inv.parsed?.streetId) setStreetId(String(inv.parsed.streetId));
  }, [inv.parsed?.streetId, streetId]);
  useEffect(() => {
    if (streetId && buildingNo && !buildingOptions.includes(buildingNo)) setBuildingNo("");
  }, [streetId, buildingNo, buildingOptions]);
  useEffect(() => {
    if (flatId && !flatOptions.some((f) => f.id === flatId)) setFlatId("");
  }, [buildingNo, flatId, flatOptions]);

  async function persistDraftSettings() {
    await updateDoc(doc(db, "communities", communityId, docCollectionName(inv), inv.id), {
      period,
      category,
      updatedAtMs: Date.now(),
      parsed: {
        ...(inv.parsed || {}),
        period,
        category,
        scope,
        streetId: streetId || null,
        buildingId: buildingNo || null,
        flatId: showFlatId ? flatId || null : null,
      },
    });
  }

  return (
    <div className="card" style={{ display: "grid", gap: 10, minWidth: 0 }}>
      <div style={cardHeaderStyle}><strong>{inv.vendorName || "Faktura"}</strong><span>{inv.title || inv.id}</span><span>Status: {statusLabel(inv.status)}</span><span>{fromCents(amount)} PLN</span><span>Kategoria: {categoryLabel(category)}</span>{ai ? <span>AI: {Number(ai.confidence || 0).toFixed(2)}</span> : null}<span>Źródło: {sourceLabel(docCollectionName(inv))}</span></div>
      <div style={formGridStyle}>
        <input className="input" style={fieldStyle} value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="YYYY-MM" />
        <select className="select" style={fieldStyle} value={category} onChange={(e) => setCategory(e.target.value)}><option value="PRAD">PRĄD</option><option value="WODA">WODA</option><option value="GAZ">GAZ</option><option value="SPRZATANIE">SPRZĄTANIE</option><option value="REMONT">REMONT</option><option value="INNE">INNE</option></select>
        <select className="select" style={fieldStyle} value={scope} onChange={(e) => { setScope(e.target.value); if (e.target.value !== "FLAT") setFlatId(""); }}><option value="COMMON">Części wspólne</option><option value="FLAT">Konkretny lokal</option></select>
        <select className="select" style={fieldStyle} value={streetId} onChange={(e) => setStreetId(e.target.value)}><option value="">Wybierz ulicę</option>{streetOptions.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}</select>
        <select className="select" style={fieldStyle} value={buildingNo} onChange={(e) => setBuildingNo(e.target.value)}><option value="">Wybierz budynek</option>{buildingOptions.map((b) => <option key={b} value={b}>{`${displayStreetName("", streetId, streetMap)} ${b}`.trim()}</option>)}</select>
        {showFlatId ? <select className="select" style={fieldStyle} value={flatId} onChange={(e) => setFlatId(e.target.value)}><option value="">Wybierz lokal</option>{flatOptions.map((f) => <option key={f.id} value={f.id}>{flatLabel({ ...f, street: displayStreetName(f.street || f.streetName, f.streetId, streetMap) })}</option>)}</select> : null}
      </div>
      <div style={actionRowStyle}>
        <button className="btnGhost" onClick={async () => { if (docCollectionName(inv) !== "ksefInvoices") { setBusy(true); try { const res = await fetch("/api/ai/invoice-analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ communityId, invoiceId: inv.id }) }); const data = await res.json(); if (!res.ok) throw new Error(data.error || "Błąd odczytu danych"); } catch (e: any) { window.alert(e?.message || "Nie udało się odczytać danych."); } finally { setBusy(false); } return; } await callable("ksefParseInvoice")({ communityId, invoiceId: inv.id }); }}>Odczytaj dane</button>
        <button className="btnGhost" onClick={async () => { setBusy(true); try { const res = await fetch("/api/ai/invoice-analyze", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ communityId, invoiceId: inv.id }) }); const data = await res.json(); if (!res.ok) throw new Error(data.error || "Błąd analizy"); } catch (e: any) { window.alert(e?.message || "Nie udało się pobrać sugestii AI."); } finally { setBusy(false); } }}>{busy ? "AI..." : "Sugestia automatyczna"}</button>
        <button className="btn" onClick={async () => {
          try {
            await persistDraftSettings();
            const result: any = await callable("approveInvoice")({ communityId, invoiceId: inv.id, assignment: { period, category, scope, streetId: streetId || null, buildingId: buildingNo || null, flatId: showFlatId ? flatId || null : null } });
            window.alert(`Przeniesiono do szkicu. Utworzono naliczenia: ${result?.data?.chargesCreated ?? result?.chargesCreated ?? 0}.`);
          } catch (e: any) {
            window.alert(e?.message || "Nie udało się przenieść faktury do szkicu.");
          }
        }}>Przenieś do szkicu</button>
        <button className="btnGhost" onClick={async () => { try { await persistDraftSettings(); window.alert("Zapisano ustawienia faktury."); } catch (e: any) { window.alert(e?.message || "Nie udało się zapisać ustawień."); } }}>Zapisz ustawienia</button>
        <button className="btnGhost" onClick={async () => { await updateDoc(doc(db, "communities", communityId, docCollectionName(inv), inv.id), { archivedAtMs: inv.archivedAtMs ? null : Date.now(), updatedAtMs: Date.now() }); }}>{inv.archivedAtMs ? "Przywróć" : "Archiwizuj"}</button>
        <button className="btnGhost" onClick={async () => { if (!window.confirm(`Usunąć fakturę ${inv.title || inv.id}?`)) return; try { await deleteDoc(doc(db, "communities", communityId, docCollectionName(inv), inv.id)); window.alert("Faktura została usunięta."); } catch (e: any) { window.alert(e?.message || "Nie udało się usunąć faktury."); } }}>Usuń</button>
      </div>
      {ai ? <div style={{ display: "grid", gap: 6 }}><div><strong>AI powód:</strong> {ai.reason || "—"}</div><div><strong>AI typ:</strong> {allocationLabel(ai.allocationType || "—")}</div><div><strong>Do sprawdzenia:</strong> {ai.needsReview ? "tak" : "nie"}</div></div> : null}
      {inv.parsed?.ocrText ? <details><summary>Tekst odczytany z dokumentu</summary><pre style={{ whiteSpace: "pre-wrap", overflowX: "auto", margin: 0 }}>{inv.parsed.ocrText}</pre></details> : null}
    </div>
  );
}
