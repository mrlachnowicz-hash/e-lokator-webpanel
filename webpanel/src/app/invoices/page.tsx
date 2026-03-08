"use client";

import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { addDoc, collection, doc, onSnapshot, orderBy, query, updateDoc } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";
import { callable } from "../../lib/functions";

type Invoice = any;

type OCRResult = {
  supplierName?: string;
  invoiceNumber?: string;
  issueDate?: string;
  dueDate?: string;
  currency?: string;
  grossAmount?: number;
  netAmount?: number;
  vatAmount?: number;
  category?: string;
  allocationType?: "COMMON" | "BUILDING" | "FLAT" | "UNKNOWN";
  suggestedBuildingId?: string;
  suggestedFlatId?: string;
  confidence?: number;
  needsReview?: boolean;
  reason?: string;
  extractedText?: string;
};

type Flat = {
  id: string;
  street?: string;
  streetId?: string;
  streetName?: string;
  buildingNo?: string;
  apartmentNo?: string;
  flatLabel?: string;
};

type StreetOption = { id: string; name: string };

type AddressOption = {
  streetId: string;
  streetName: string;
  buildingNo: string;
};

const formGridStyle: CSSProperties = {
  display: "grid",
  gap: 10,
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  alignItems: "stretch",
  minWidth: 0,
};

const actionRowStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
  alignItems: "center",
};

const cardHeaderStyle: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 12,
  alignItems: "center",
  minWidth: 0,
};

const fieldStyle: CSSProperties = {
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
};

function fromCents(cents: unknown) {
  return (Number(cents || 0) / 100).toFixed(2);
}

function normalizeStreetId(name: string) {
  return String(name || "")
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "");
}

function resolveFlatLabel(flat: Flat) {
  return String(flat.flatLabel || `${flat.street || flat.streetName || ""} ${flat.buildingNo || ""}/${flat.apartmentNo || ""}`.trim());
}

function InvoiceAssignmentFields({ inv, communityId }: { inv: Invoice; communityId: string }) {
  const [flats, setFlats] = useState<Flat[]>([]);
  const [streetOptions, setStreetOptions] = useState<StreetOption[]>([]);
  const [streetId, setStreetId] = useState("");
  const [buildingNo, setBuildingNo] = useState("");
  const [flatId, setFlatId] = useState(inv.parsed?.flatId || inv.ai?.suggestion?.suggestedFlatId || "");
  const [period, setPeriod] = useState(inv.parsed?.period || inv.period || new Date().toISOString().slice(0, 7));
  const [category, setCategory] = useState(inv.parsed?.category || inv.category || "INNE");
  const [scope, setScope] = useState(inv.parsed?.scope || (inv.ai?.suggestion?.allocationType === "FLAT" ? "FLAT" : "COMMON"));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!communityId) return;
    let streetNamesById = new Map<string, string>();
    let flatDocs: Flat[] = [];

    const merge = () => {
      const mergedFlats = flatDocs.map((flat) => {
        const resolvedStreetId = String(flat.streetId || normalizeStreetId(String(flat.street || flat.streetName || ""))).trim();
        const resolvedStreetName = String(flat.street || flat.streetName || streetNamesById.get(resolvedStreetId) || "").trim();
        return {
          ...flat,
          streetId: resolvedStreetId,
          street: resolvedStreetName,
          streetName: resolvedStreetName,
          flatLabel: resolveFlatLabel({ ...flat, street: resolvedStreetName, streetName: resolvedStreetName }),
        };
      });
      setFlats(mergedFlats);

      const byStreet = new Map<string, StreetOption>();
      mergedFlats.forEach((flat) => {
        if (!flat.streetId) return;
        byStreet.set(flat.streetId, { id: flat.streetId, name: flat.street || flat.streetName || flat.streetId });
      });
      streetNamesById.forEach((name, id) => {
        byStreet.set(id, byStreet.get(id) || { id, name });
      });
      setStreetOptions(Array.from(byStreet.values()).sort((a, b) => a.name.localeCompare(b.name, "pl")));
    };

    const unsubStreets = onSnapshot(query(collection(db, "communities", communityId, "streets")), (snap) => {
      streetNamesById = new Map(snap.docs.map((d) => [d.id, String((d.data() as any).name || d.id)]));
      merge();
    });
    const unsubFlats = onSnapshot(query(collection(db, "communities", communityId, "flats")), (snap) => {
      flatDocs = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
      merge();
    });
    return () => { unsubStreets(); unsubFlats(); };
  }, [communityId]);

  useEffect(() => {
    if (!flats.length) return;
    if (flatId) {
      const selectedFlat = flats.find((flat) => flat.id === flatId);
      if (selectedFlat) {
        setStreetId(selectedFlat.streetId || normalizeStreetId(String(selectedFlat.street || "")));
        setBuildingNo(String(selectedFlat.buildingNo || ""));
        return;
      }
    }
    const parsedBuilding = String(inv.parsed?.buildingId || inv.ai?.suggestion?.suggestedBuildingId || "").trim();
    const parsedStreetId = String(inv.parsed?.streetId || "").trim();
    if (parsedStreetId) setStreetId(parsedStreetId);
    if (parsedBuilding) setBuildingNo(parsedBuilding);
  }, [flats, flatId, inv]);

  const buildingOptions = useMemo(() => {
    const seen = new Set<string>();
    return flats
      .filter((flat) => !streetId || flat.streetId === streetId)
      .filter((flat) => {
        const key = `${flat.streetId}|${flat.buildingNo || ""}`;
        if (!flat.buildingNo || seen.has(key)) return false;
        seen.add(key);
        return true;
      })
      .map((flat) => ({ value: String(flat.buildingNo || ""), label: `${flat.street || flat.streetName || ""} ${flat.buildingNo || ""}`.trim() }))
      .sort((a, b) => a.label.localeCompare(b.label, "pl", { numeric: true }));
  }, [flats, streetId]);

  const flatOptions = useMemo(() => {
    return flats
      .filter((flat) => (!streetId || flat.streetId === streetId) && (!buildingNo || String(flat.buildingNo || "") === buildingNo))
      .sort((a, b) => String(a.apartmentNo || "").localeCompare(String(b.apartmentNo || ""), "pl", { numeric: true }));
  }, [flats, streetId, buildingNo]);

  useEffect(() => {
    if (scope !== "FLAT") {
      setFlatId("");
      return;
    }
    if (flatId && !flatOptions.some((flat) => flat.id === flatId)) {
      setFlatId("");
    }
  }, [scope, flatOptions, flatId]);

  const amount = Number(inv.parsed?.amountCents || inv.totalGrossCents || 0);
  const ai = inv.ai?.suggestion;
  const showFlat = scope === "FLAT";

  return (
    <div className="card" style={{ display: "grid", gap: 10, minWidth: 0 }}>
      <div style={cardHeaderStyle}>
        <strong>{inv.vendorName || "Faktura"}</strong>
        <span>{inv.title || inv.id}</span>
        <span>status: {inv.status}</span>
        <span>{fromCents(amount)} PLN</span>
        {ai ? <span>AI: {Number(ai.confidence || 0).toFixed(2)}</span> : null}
      </div>

      <div style={formGridStyle}>
        <input className="input" style={fieldStyle} value={period} onChange={(e) => setPeriod(e.target.value)} placeholder="YYYY-MM" />
        <select className="select" style={fieldStyle} value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="PRAD">PRĄD</option>
          <option value="WODA">WODA</option>
          <option value="GAZ">GAZ</option>
          <option value="SPRZATANIE">SPRZĄTANIE</option>
          <option value="REMONT">REMONT</option>
          <option value="INNE">INNE</option>
        </select>
        <select className="select" style={fieldStyle} value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="COMMON">Części wspólne</option>
          <option value="FLAT">Konkretny lokal</option>
        </select>
        <select className="select" style={fieldStyle} value={streetId} onChange={(e) => { setStreetId(e.target.value); setBuildingNo(""); setFlatId(""); }}>
          <option value="">Wybierz ulicę</option>
          {streetOptions.map((street) => <option key={street.id} value={street.id}>{street.name}</option>)}
        </select>
        <select className="select" style={fieldStyle} value={buildingNo} onChange={(e) => { setBuildingNo(e.target.value); setFlatId(""); }}>
          <option value="">Wybierz budynek</option>
          {buildingOptions.map((building) => <option key={building.value} value={building.value}>{building.label}</option>)}
        </select>
        {showFlat ? (
          <select className="select" style={fieldStyle} value={flatId} onChange={(e) => setFlatId(e.target.value)}>
            <option value="">Wybierz lokal</option>
            {flatOptions.map((flat) => <option key={flat.id} value={flat.id}>{flat.flatLabel || resolveFlatLabel(flat)}</option>)}
          </select>
        ) : null}
      </div>

      <div style={actionRowStyle}>
        <button className="btnGhost" onClick={async () => {
          await callable("ksefParseInvoice")({ communityId, invoiceId: inv.id });
        }}>Parse</button>
        <button className="btnGhost" onClick={async () => {
          setBusy(true);
          try {
            const res = await fetch("/api/ai/invoice-analyze", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ communityId, invoiceId: inv.id }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.error || "AI error");
          } finally {
            setBusy(false);
          }
        }}>{busy ? "AI..." : "AI sugestia"}</button>
        <button className="btn" onClick={async () => {
          await callable("approveInvoice")({
            communityId,
            invoiceId: inv.id,
            assignment: {
              period,
              category,
              scope,
              streetId: streetId || null,
              buildingId: buildingNo || null,
              flatId: showFlat ? flatId || null : null,
            },
          });
        }}>Nalicz do szkicu</button>
        <button className="btnGhost" onClick={async () => {
          await updateDoc(doc(db, "communities", communityId, "invoices", inv.id), { archivedAtMs: inv.archivedAtMs ? null : Date.now(), updatedAtMs: Date.now() });
        }}>{inv.archivedAtMs ? "Przywróć" : "Archiwizuj"}</button>
        <button className="btnGhost" onClick={async () => {
          if (window.confirm(`Usunąć fakturę ${inv.title || inv.id}?`)) {
            await updateDoc(doc(db, "communities", communityId, "invoices", inv.id), { deletedAtMs: Date.now(), archivedAtMs: Date.now(), status: "DELETED", updatedAtMs: Date.now() });
          }
        }}>Kosz</button>
      </div>

      {ai ? (
        <div style={{ display: "grid", gap: 6 }}>
          <div><strong>AI powód:</strong> {ai.reason || "—"}</div>
          <div><strong>AI typ:</strong> {ai.allocationType || "—"}</div>
          <div><strong>Review:</strong> {ai.needsReview ? "tak" : "nie"}</div>
        </div>
      ) : null}

      {inv.parsed?.ocrText ? (
        <details>
          <summary>Tekst OCR / parse</summary>
          <pre style={{ whiteSpace: "pre-wrap", overflowX: "auto", margin: 0 }}>{inv.parsed.ocrText}</pre>
        </details>
      ) : null}
    </div>
  );
}

export default function InvoicesPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [items, setItems] = useState<Invoice[]>([]);
  const [msg, setMsg] = useState("");
  const [ocrBusy, setOcrBusy] = useState(false);
  const [ocrResult, setOcrResult] = useState<OCRResult | null>(null);
  const [form, setForm] = useState({
    vendorName: "",
    title: "",
    period: new Date().toISOString().slice(0, 7),
    totalGross: "",
    category: "INNE",
  });

  useEffect(() => {
    if (!communityId) return;
    const q = query(collection(db, "communities", communityId, "invoices"), orderBy("createdAtMs", "desc"));
    return onSnapshot(q, (snap) => setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))));
  }, [communityId]);

  const stats = useMemo(() => ({
    total: items.filter((x) => !x.archivedAtMs && x.deletedAtMs !== true).length,
    archived: items.filter((x) => !!x.archivedAtMs).length,
    staged: items.filter((x) => !x.archivedAtMs && String(x.status || "").includes("STAGED")).length,
    review: items.filter((x) => !x.archivedAtMs && (x.ai?.suggestion?.needsReview || x.parsed?.needsReview)).length,
  }), [items]);

  async function handlePdf(file: File) {
    if (!communityId) return;
    setOcrBusy(true);
    setMsg("");
    try {
      const body = new FormData();
      body.append("communityId", communityId);
      body.append("file", file);
      const res = await fetch("/api/ai/invoice-ocr", { method: "POST", body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "OCR error");
      setOcrResult(data);
      setForm((prev) => ({
        ...prev,
        vendorName: data.supplierName || prev.vendorName,
        title: data.invoiceNumber || prev.title,
        totalGross: data.grossAmount != null ? String(data.grossAmount) : prev.totalGross,
        category: data.category || prev.category,
      }));
      setMsg(data.needsReview ? "AI odczytało fakturę, ale oznaczyło ją do review." : "AI odczytało fakturę PDF i przygotowało szkic.");
    } catch (error: any) {
      setMsg(error?.message || "Nie udało się odczytać PDF.");
    } finally {
      setOcrBusy(false);
    }
  }

  async function saveOcrDraft() {
    if (!communityId || !ocrResult) return;
    const period = form.period || new Date().toISOString().slice(0, 7);
    await addDoc(collection(db, "communities", communityId, "invoices"), {
      vendorName: ocrResult.supplierName || form.vendorName,
      title: ocrResult.invoiceNumber || form.title || "Faktura z PDF",
      period,
      category: ocrResult.category || form.category || "INNE",
      totalGrossCents: Math.round(Number(ocrResult.grossAmount || form.totalGross || 0) * 100),
      currency: ocrResult.currency || "PLN",
      source: "PDF_AI",
      status: ocrResult.needsReview ? "SUGGESTED" : "READY_TO_STAGE",
      parsed: {
        period,
        category: ocrResult.category || form.category || "INNE",
        scope: ocrResult.allocationType === "FLAT" ? "FLAT" : "COMMON",
        buildingId: ocrResult.suggestedBuildingId || "",
        flatId: ocrResult.suggestedFlatId || "",
        amountCents: Math.round(Number(ocrResult.grossAmount || form.totalGross || 0) * 100),
        needsReview: Boolean(ocrResult.needsReview),
        reason: ocrResult.reason || "",
        ocrText: ocrResult.extractedText || "",
        supplierName: ocrResult.supplierName || "",
        invoiceNumber: ocrResult.invoiceNumber || "",
        issueDate: ocrResult.issueDate || "",
        dueDate: ocrResult.dueDate || "",
      },
      ai: { suggestion: ocrResult, updatedAtMs: Date.now() },
      createdAtMs: Date.now(),
      updatedAtMs: Date.now(),
    });
    setMsg("Dodano szkic faktury z OCR do panelu.");
    setOcrResult(null);
  }

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16, minWidth: 0 }}>
        <h2>Faktury</h2>
        <div className="card" style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          <div>Łącznie: <strong>{stats.total}</strong></div>
          <div>W szkicu / staged: <strong>{stats.staged}</strong></div>
          <div>Do review: <strong>{stats.review}</strong></div>
          <div>Archiwum: <strong>{stats.archived}</strong></div>
        </div>

        <div className="card" style={{ display: "grid", gap: 12, minWidth: 0 }}>
          <h3>AI OCR faktury PDF</h3>
          <p style={{ opacity: 0.8, marginTop: -6 }}>PDF z tekstem jest czytany systemowo, a AI robi klasyfikację, przypisanie i confidence. Nie księgujemy automatycznie — wynik trafia jako szkic.</p>
          <input type="file" accept="application/pdf" onChange={async (e) => {
            const file = e.target.files?.[0];
            if (file) await handlePdf(file);
          }} />
          {ocrBusy ? <div>Analiza AI...</div> : null}
          {ocrResult ? (
            <div style={{ display: "grid", gap: 10 }}>
              <div><strong>Dostawca:</strong> {ocrResult.supplierName || "—"}</div>
              <div><strong>Numer faktury:</strong> {ocrResult.invoiceNumber || "—"}</div>
              <div><strong>Kategoria:</strong> {ocrResult.category || "—"}</div>
              <div><strong>Typ alokacji:</strong> {ocrResult.allocationType || "—"}</div>
              <div><strong>Confidence:</strong> {Number(ocrResult.confidence || 0).toFixed(2)}</div>
              <div><strong>Powód:</strong> {ocrResult.reason || "—"}</div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button className="btn" onClick={saveOcrDraft}>Zapisz szkic z OCR</button>
                <button className="btnGhost" onClick={() => setOcrResult(null)}>Wyczyść</button>
              </div>
              <details>
                <summary>Podgląd tekstu z PDF</summary>
                <pre style={{ whiteSpace: "pre-wrap", overflowX: "auto", margin: 0 }}>{ocrResult.extractedText || "Brak tekstu"}</pre>
              </details>
            </div>
          ) : null}
        </div>

        <div className="card" style={{ display: "grid", gap: 12, minWidth: 0 }}>
          <h3>Dodaj ręcznie</h3>
          <div style={formGridStyle}>
            <input className="input" style={fieldStyle} placeholder="Dostawca" value={form.vendorName} onChange={(e) => setForm({ ...form, vendorName: e.target.value })} />
            <input className="input" style={fieldStyle} placeholder="Tytuł" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <input className="input" style={fieldStyle} placeholder="YYYY-MM" value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })} />
            <input className="input" style={fieldStyle} placeholder="Kwota brutto" value={form.totalGross} onChange={(e) => setForm({ ...form, totalGross: e.target.value })} />
            <select className="select" style={fieldStyle} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              <option value="PRAD">PRĄD</option>
              <option value="WODA">WODA</option>
              <option value="GAZ">GAZ</option>
              <option value="SPRZATANIE">SPRZĄTANIE</option>
              <option value="REMONT">REMONT</option>
              <option value="INNE">INNE</option>
            </select>
          </div>
          <div style={actionRowStyle}>
            <button className="btn" onClick={async () => {
              await addDoc(collection(db, "communities", communityId, "invoices"), {
                vendorName: form.vendorName,
                title: form.title,
                period: form.period,
                category: form.category,
                totalGrossCents: Math.round(Number((form.totalGross || "0").replace(",", ".")) * 100),
                currency: "PLN",
                status: "NOWA",
                source: "MANUAL",
                createdAtMs: Date.now(),
                updatedAtMs: Date.now(),
              });
              setForm({ ...form, vendorName: "", title: "", totalGross: "" });
            }}>Dodaj fakturę</button>
            <button className="btnGhost" onClick={async () => {
              await callable("ksefFetchInvoices")({ communityId, period: form.period });
              setMsg("Pobrano przykładowe faktury KSeF do kolekcji ksefInvoices.");
            }}>Pobierz mock KSeF</button>
          </div>
        </div>

        {msg ? <div style={{ color: "#8ef0c8", fontWeight: 700 }}>{msg}</div> : null}

        <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
          {items.filter((x) => !x.archivedAtMs).map((inv) => <InvoiceAssignmentFields key={inv.id} inv={inv} communityId={communityId} />)}
          {items.some((x) => !!x.archivedAtMs) ? <div className="card" style={{ marginTop: 8, display: "grid", gap: 10 }}><h3>Archiwum faktur</h3>{items.filter((x) => !!x.archivedAtMs).map((inv) => <InvoiceAssignmentFields key={inv.id} inv={inv} communityId={communityId} />)}</div> : null}
        </div>
      </div>
    </RequireAuth>
  );
}
