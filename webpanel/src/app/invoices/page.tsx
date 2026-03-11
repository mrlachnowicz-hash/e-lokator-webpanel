"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { addDoc, collection, deleteDoc, doc, getDocs, onSnapshot } from "firebase/firestore";
import { callable } from "@/lib/functions";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/authContext";
import { normalizeStreetId } from "@/lib/streetUtils";
import { Nav } from "@/components/Nav";
import { RequireAuth } from "@/components/RequireAuth";

type InvoiceItem = any & { id: string; sourceCollection: "invoices" | "ksefInvoices" };

type AssignmentState = {
  scope: string;
  streetId: string;
  streetName: string;
  buildingId: string;
  staircaseId: string;
  flatId: string;
  apartmentNo: string;
  period: string;
  category: string;
};

type StreetOption = { id: string; name: string };

type FlatItem = any & { id: string };

const approveInvoiceCallable = callable<any, any>("approveInvoice");
const fetchKsefCallable = callable<any, any>("ksefFetchInvoices");

function normalizeScope(value: any) {
  const raw = String(value || "").trim().toUpperCase();
  if (["LOCAL", "LOKAL"].includes(raw)) return "FLAT";
  if (["BUDYNEK"].includes(raw)) return "BUILDING";
  if (["KLATKA", "ENTRANCE"].includes(raw)) return "STAIRCASE";
  if (["WSPOLNOTA"].includes(raw)) return "COMMUNITY";
  if (["WSPOLNE", "CZESCI_WSPOLNE"].includes(raw)) return "COMMON";
  return ["FLAT", "BUILDING", "STAIRCASE", "COMMON", "COMMUNITY"].includes(raw) ? raw : "COMMON";
}

function monthLabel(period: string) {
  const names = ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec", "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"];
  const m = String(period || "").match(/^(\d{4})-(\d{2})/);
  if (!m) return period || "—";
  return `${names[Number(m[2]) - 1] || m[2]} ${m[1]}`;
}

function moneyFromInvoice(item: InvoiceItem) {
  const cents = Number(item?.parsed?.totalGrossCents || item?.parsed?.amountCents || item?.totalGrossCents || item?.amountCents || 0);
  return `${(cents / 100).toFixed(2)} PLN`;
}

function normalizeInvoice(docId: string, sourceCollection: "invoices" | "ksefInvoices", data: any): InvoiceItem {
  return { id: docId, sourceCollection, ...(data || {}) };
}

function inferPeriod(item: InvoiceItem) {
  return String(item?.period || item?.parsed?.period || item?.ai?.suggestion?.period || item?.archiveMonth || "").trim();
}

function inferCategory(item: InvoiceItem) {
  return String(item?.category || item?.parsed?.category || item?.ai?.suggestion?.category || "INNE").trim() || "INNE";
}

function inferStreetName(item: InvoiceItem) {
  return String(item?.assigned?.streetName || item?.parsed?.suggestedStreetName || item?.parsed?.streetName || item?.streetName || "").trim();
}

function inferStreetId(item: InvoiceItem) {
  return String(item?.assigned?.streetId || item?.parsed?.suggestedStreetId || item?.parsed?.streetId || "").trim();
}

function inferScope(item: InvoiceItem) {
  return normalizeScope(item?.assigned?.scope || item?.scope || item?.parsed?.scope || item?.parsed?.allocationType || item?.ai?.suggestion?.scope || item?.ai?.suggestion?.allocationType || "COMMON");
}

function inferAssignment(item: InvoiceItem): AssignmentState {
  const streetName = inferStreetName(item);
  const streetId = inferStreetId(item) || normalizeStreetId(streetName);
  return {
    scope: inferScope(item),
    streetId,
    streetName,
    buildingId: String(item?.assigned?.buildingId || item?.parsed?.suggestedBuildingId || item?.parsed?.buildingId || item?.parsed?.buildingNo || "").trim(),
    staircaseId: String(item?.assigned?.staircaseId || item?.parsed?.suggestedStaircaseId || item?.parsed?.staircaseId || "").trim(),
    flatId: String(item?.assigned?.flatId || item?.parsed?.suggestedFlatId || item?.parsed?.flatId || "").trim(),
    apartmentNo: String(item?.assigned?.apartmentNo || item?.parsed?.suggestedApartmentNo || item?.parsed?.apartmentNo || "").trim(),
    period: inferPeriod(item),
    category: inferCategory(item),
  };
}

function flatLabel(flat: FlatItem) {
  return String(flat?.flatLabel || `${flat?.street || flat?.streetName || ""} ${flat?.buildingNo || ""}/${flat?.apartmentNo || flat?.flatNumber || ""}`.trim() || flat?.id || "—");
}

export default function InvoicesPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [invoices, setInvoices] = useState<InvoiceItem[]>([]);
  const [flats, setFlats] = useState<FlatItem[]>([]);
  const [assignments, setAssignments] = useState<Record<string, AssignmentState>>({});
  const [uploading, setUploading] = useState(false);
  const [busyId, setBusyId] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [ksefDebug, setKsefDebug] = useState<{ created: number; duplicates: number; totalVisible: number }>({ created: 0, duplicates: 0, totalVisible: 0 });
  const [ksefRecent, setKsefRecent] = useState<InvoiceItem[]>([]);

  useEffect(() => {
    if (!communityId) return;
    const unsubInvoices = onSnapshot(collection(db, "communities", communityId, "invoices"), (snap) => {
      setInvoices((prev) => {
        const other = prev.filter((item) => item.sourceCollection !== "invoices");
        const own = snap.docs.map((d) => normalizeInvoice(d.id, "invoices", d.data()));
        return [...other, ...own];
      });
    });
    const unsubKsef = onSnapshot(collection(db, "communities", communityId, "ksefInvoices"), (snap) => {
      const own = snap.docs.map((d) => normalizeInvoice(d.id, "ksefInvoices", d.data()));
      setKsefRecent(own.filter((item) => item.isArchived !== true && !item.archivedAtMs && !["PRZENIESIONA_DO_SZKICU", "ARCHIVED"].includes(String(item.status || "").toUpperCase())));
      setInvoices((prev) => {
        const other = prev.filter((item) => item.sourceCollection !== "ksefInvoices");
        return [...other, ...own];
      });
    }, () => {
      setKsefRecent([]);
      setInvoices((prev) => prev.filter((item) => item.sourceCollection !== "ksefInvoices"));
    });
    const unsubFlats = onSnapshot(collection(db, "communities", communityId, "flats"), (snap) => {
      setFlats(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })));
    });
    return () => {
      unsubInvoices();
      unsubKsef();
      unsubFlats();
    };
  }, [communityId]);

  const activeInvoices = useMemo(() => {
    return invoices
      .filter((item) => item.isArchived !== true && !item.archivedAtMs && !["PRZENIESIONA_DO_SZKICU", "ARCHIVED"].includes(String(item.status || "").toUpperCase()))
      .sort((a, b) => Number(b.updatedAtMs || b.createdAtMs || 0) - Number(a.updatedAtMs || a.createdAtMs || 0));
  }, [invoices]);

  const visibleKsefInvoices = useMemo(() => {
    return activeInvoices.filter((item) => item.sourceCollection === "ksefInvoices");
  }, [activeInvoices]);

  useEffect(() => {
    setAssignments((prev) => {
      const next = { ...prev };
      activeInvoices.forEach((item) => {
        if (!next[item.id]) next[item.id] = inferAssignment(item);
      });
      Object.keys(next).forEach((id) => {
        if (!activeInvoices.some((item) => item.id === id)) delete next[id];
      });
      return next;
    });
  }, [activeInvoices]);

  const streetOptions = useMemo<StreetOption[]>(() => {
    const map = new Map<string, string>();
    flats.forEach((flat) => {
      const name = String(flat.street || flat.streetName || "").trim();
      const id = String(flat.streetId || normalizeStreetId(name) || "").trim();
      if (id) map.set(id, name || id);
    });
    return Array.from(map.entries()).map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name, "pl"));
  }, [flats]);

  const updateAssignment = (invoiceId: string, patch: Partial<AssignmentState>) => {
    setAssignments((prev) => ({
      ...prev,
      [invoiceId]: { ...(prev[invoiceId] || inferAssignment(activeInvoices.find((item) => item.id === invoiceId) as InvoiceItem)), ...patch },
    }));
  };

  const handleSingleUpload = async (file: File | null) => {
    if (!file || !communityId) return;
    setUploading(true);
    setMessage(null);
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("communityId", communityId);
      const res = await fetch("/api/ai/invoice-ocr", { method: "POST", body: form });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Błąd OCR faktury.");
      const grossAmount = Number(data.grossAmount || 0);
      const totalGrossCents = Math.round(grossAmount * 100);
      const period = String((data.issueDate || "").slice(0, 7) || "").trim();
      const scope = normalizeScope(data.allocationType || "COMMON");
      const now = Date.now();
      await addDoc(collection(db, "communities", communityId, "invoices"), {
        createdAtMs: now,
        updatedAtMs: now,
        source: "WEBPANEL_OCR",
        status: data.needsReview ? "NOWA" : "READY_TO_STAGE",
        filename: String(data.filename || file.name || "invoice"),
        supplierName: String(data.supplierName || ""),
        vendorName: String(data.supplierName || ""),
        invoiceNumber: String(data.invoiceNumber || ""),
        issueDate: String(data.issueDate || ""),
        dueDate: String(data.dueDate || ""),
        currency: String(data.currency || "PLN"),
        amountCents: totalGrossCents,
        totalGrossCents,
        period,
        category: String(data.category || "INNE"),
        scope,
        extractedText: String(data.extractedText || ""),
        parsed: {
          sellerName: String(data.supplierName || ""),
          issueDate: String(data.issueDate || ""),
          dueDate: String(data.dueDate || ""),
          period,
          totalGrossCents,
          amountCents: totalGrossCents,
          currency: String(data.currency || "PLN"),
          category: String(data.category || "INNE"),
          scope,
          allocationType: scope,
          suggestedBuildingId: String(data.suggestedBuildingId || ""),
          suggestedFlatId: String(data.suggestedFlatId || ""),
          suggestedStreetId: String(data.suggestedStreetId || ""),
          suggestedStreetName: String(data.suggestedStreetName || ""),
          suggestedApartmentNo: String(data.suggestedApartmentNo || ""),
          suggestedStaircaseId: String(data.suggestedStaircaseId || ""),
          reason: String(data.reason || ""),
          ocrText: String(data.extractedText || ""),
          extractedText: String(data.extractedText || ""),
        },
        assigned: {
          scope,
          streetId: String(data.suggestedStreetId || ""),
          streetName: String(data.suggestedStreetName || ""),
          buildingId: String(data.suggestedBuildingId || ""),
          staircaseId: String(data.suggestedStaircaseId || ""),
          flatId: String(data.suggestedFlatId || ""),
          apartmentNo: String(data.suggestedApartmentNo || ""),
          period,
          category: String(data.category || "INNE"),
        },
        ocr: {
          pipeline: String(data.pipeline || ""),
          confidence: Number(data.confidence || 0),
          needsReview: Boolean(data.needsReview),
          reason: String(data.reason || ""),
        },
        ai: {
          status: "READY",
          suggestion: {
            category: String(data.category || "INNE"),
            allocationType: scope,
            scope,
            buildingId: String(data.suggestedBuildingId || ""),
            flatId: String(data.suggestedFlatId || ""),
            streetId: String(data.suggestedStreetId || ""),
            streetName: String(data.suggestedStreetName || ""),
            apartmentNo: String(data.suggestedApartmentNo || ""),
            staircaseId: String(data.suggestedStaircaseId || ""),
            confidence: Number(data.confidence || 0),
            needsReview: Boolean(data.needsReview),
            reason: String(data.reason || ""),
            period,
          },
          updatedAtMs: now,
        },
      });
      setMessage(`Dodano fakturę ${String(data.supplierName || file.name)} do listy roboczej.`);
    } catch (error: any) {
      const err = new Error(error?.message || "Błąd dodawania faktury.");
      setMessage(err.message);
      throw err;
    } finally {
      setUploading(false);
    }
  };


  const handleUploadQueue = async (files: File[]) => {
    const queue = files.filter(Boolean);
    if (!queue.length) return;
    const successes: string[] = [];
    const failures: string[] = [];
    for (const file of queue) {
      try {
        await handleSingleUpload(file);
        successes.push(file.name);
      } catch (error: any) {
        failures.push(`${file.name}: ${error?.message || "Błąd dodawania faktury."}`);
      }
    }
    if (queue.length === 1 && failures.length === 0) return;
    const parts: string[] = [];
    parts.push(`Dodano ${successes.length}/${queue.length} faktur.`);
    if (failures.length) parts.push(`Błędy: ${failures.join(" | ")}`);
    setMessage(parts.join(" "));
  };

  const stageInvoice = async (item: InvoiceItem) => {
    if (!communityId) return;
    const assignment = assignments[item.id] || inferAssignment(item);
    setBusyId(item.id);
    setMessage(null);
    try {
      const response = await approveInvoiceCallable({
        communityId,
        invoiceId: item.id,
        assignment: {
          scope: normalizeScope(assignment.scope),
          streetId: assignment.streetId || normalizeStreetId(assignment.streetName || ""),
          streetName: assignment.streetName || "",
          buildingId: assignment.buildingId || "",
          staircaseId: assignment.staircaseId || "",
          flatId: assignment.flatId || "",
          apartmentNo: assignment.apartmentNo || "",
          period: assignment.period || inferPeriod(item),
          category: assignment.category || inferCategory(item),
        },
      });
      const data: any = response.data || {};
      setMessage(`Przeniesiono do szkicu: ${data.chargesCreated || 0} naliczeń, zakres ${data.scope || normalizeScope(assignment.scope)}.`);
    } catch (error: any) {
      setMessage(error?.message || error?.details || "Błąd przenoszenia faktury do szkicu.");
    } finally {
      setBusyId("");
    }
  };

  const canDeleteInvoice = async (item: InvoiceItem) => {
    const count = Number(item.settlementDraftCount || 0);
    if (count > 0) return false;
    const assigned = Array.isArray(item?.assigned?.affectedFlatIds) ? item.assigned.affectedFlatIds : [];
    if (!assigned.length || !communityId || !inferPeriod(item)) return true;
    const drafts = await getDocs(collection(db, "communities", communityId, "settlementDrafts"));
    return !drafts.docs.some((d) => {
      const data: any = d.data() || {};
      return String(data.invoiceId || "") === item.id || (assigned.includes(String(data.flatId || "")) && String(data.period || "") === inferPeriod(item));
    });
  };

  const deleteInvoice = async (item: InvoiceItem) => {
    if (!communityId) return;
    setBusyId(item.id);
    setMessage(null);
    try {
      const allowed = await canDeleteInvoice(item);
      if (!allowed) throw new Error("Nie można usunąć faktury powiązanej ze szkicem rozliczenia.");
      await deleteDoc(doc(db, "communities", communityId, item.sourceCollection, item.id));
      setMessage(`Usunięto fakturę ${item.id}.`);
    } catch (error: any) {
      setMessage(error?.message || "Błąd usuwania faktury.");
    } finally {
      setBusyId("");
    }
  };

  const fetchFromKsef = async () => {
    if (!communityId) return;
    setUploading(true);
    setMessage(null);
    try {
      const res: any = await fetchKsefCallable({ communityId, count: 5 });
      const createdRows: InvoiceItem[] = Array.isArray(res?.data?.created)
        ? res.data.created.map((item: any) => normalizeInvoice(String(item.id), "ksefInvoices", item))
        : [];
      const created = createdRows.length;
      const duplicates = Number(res?.data?.duplicates?.length || 0);
      let totalVisible = createdRows.length;
      try {
        const ksefSnap = await getDocs(collection(db, "communities", communityId, "ksefInvoices"));
        const freshKsefRows = ksefSnap.docs.map((d) => normalizeInvoice(d.id, "ksefInvoices", d.data()));
        totalVisible = freshKsefRows.filter((item) => item.isArchived !== true && !item.archivedAtMs && !["PRZENIESIONA_DO_SZKICU", "ARCHIVED"].includes(String(item.status || "").toUpperCase())).length;
        setKsefRecent(freshKsefRows.filter((item) => item.isArchived !== true && !item.archivedAtMs && !["PRZENIESIONA_DO_SZKICU", "ARCHIVED"].includes(String(item.status || "").toUpperCase())));
      } catch {}
      if (createdRows.length) {
        setInvoices((prev) => {
          const existing = new Map(prev.map((item) => [`${item.sourceCollection}_${item.id}`, item]));
          createdRows.forEach((item) => existing.set(`${item.sourceCollection}_${item.id}`, item));
          return Array.from(existing.values());
        });
        setKsefRecent((prev) => {
          const existing = new Map(prev.map((item) => [`${item.sourceCollection}_${item.id}`, item]));
          createdRows.forEach((item) => existing.set(`${item.sourceCollection}_${item.id}`, item));
          return Array.from(existing.values());
        });
      }
      setKsefDebug({ created, duplicates, totalVisible });
      setMessage(`Pobrano z KSeF: ${created} faktur, duplikaty: ${duplicates}. Widoczne teraz na liście: ${totalVisible}.`);
    } catch (error: any) {
      setMessage(error?.message || error?.details || "Błąd pobierania z KSeF.");
    } finally {
      setUploading(false);
    }
  };

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0 }}>Faktury</h1>
            <div style={{ opacity: 0.75 }}>Bieżące faktury robocze i do przeniesienia do szkicu rozliczeń.</div>
          </div>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            <button className="btnGhost" onClick={fetchFromKsef} disabled={uploading}>Pobierz z KSeF</button>
            <Link href="/ksef" className="btnGhost" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>Ustaw KSeF</Link>
            <Link href="/invoices/archive" className="btnGhost" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>Archiwum faktur</Link>
          </div>
        </div>

        <div className="card" style={{ display: "grid", gap: 12 }}>
          <h3>Dodaj fakturę OCR</h3>
          <input type="file" multiple accept=".pdf,.jpg,.jpeg,.png,.webp" onChange={async (e) => {
            await handleUploadQueue(Array.from(e.target.files || []));
            e.currentTarget.value = "";
          }} />
          <div style={{ opacity: 0.78 }}>Obsługa: PDF, JPG, JPEG, PNG, WEBP. Możesz dodać kilka faktur naraz — pliki zostaną przetworzone po kolei i zakolejkowane.</div>
        </div>

        {message ? <div style={{ color: "#8ef0c8" }}>{message}</div> : null}

        <div className="card" style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
          <div>Aktywne faktury: <strong>{activeInvoices.length}</strong></div>
          <div>Aktywne z KSeF: <strong>{visibleKsefInvoices.length}</strong></div>
          <div>Lokale w bazie: <strong>{flats.length}</strong></div>
          <div>Upload OCR: <strong>{uploading ? "w toku" : "gotowy"}</strong></div>
        </div>

        {ksefDebug.created > 0 || ksefDebug.duplicates > 0 ? (
          <div className="card" style={{ display: "grid", gap: 6 }}>
            <strong>Ostatni import KSeF</strong>
            <div>Dodane: {ksefDebug.created} · Duplikaty: {ksefDebug.duplicates} · Widoczne na liście: {ksefDebug.totalVisible}</div>
            <div style={{ opacity: 0.78 }}>Jeśli liczba „Widoczne na liście” jest większa od zera, faktury są już niżej na tej stronie jako źródło KSeF.</div>
          </div>
        ) : null}

        {ksefRecent.length > 0 ? (
          <div className="card" style={{ display: "grid", gap: 10 }}>
            <strong>Ostatnio pobrane z KSeF</strong>
            {ksefRecent.slice(0, 5).map((item) => (
              <div key={`ksef_recent_${item.id}`} style={{ display: "flex", gap: 12, justifyContent: "space-between", flexWrap: "wrap", borderTop: "1px solid rgba(255,255,255,.08)", paddingTop: 8 }}>
                <div style={{ display: "grid", gap: 4 }}>
                  <strong>{String(item.supplierName || item.vendorName || item.parsed?.sellerName || item.ksefNumber || item.id)}</strong>
                  <div style={{ opacity: 0.78 }}>Numer: {String(item.invoiceNumber || item.parsed?.invoiceNumber || item.ksefNumber || "—")}</div>
                  <div style={{ opacity: 0.78 }}>Okres: {String(item.period || item.parsed?.period || "—")}</div>
                </div>
                <div style={{ fontWeight: 700 }}>{moneyFromInvoice(item)}</div>
              </div>
            ))}
          </div>
        ) : null}

        <div style={{ display: "grid", gap: 12 }}>
          {activeInvoices.length === 0 ? <div className="card">Brak aktywnych faktur roboczych.</div> : activeInvoices.map((item) => {
            const assignment = assignments[item.id] || inferAssignment(item);
            const invoiceStreetId = assignment.streetId || normalizeStreetId(assignment.streetName || "");
            const buildingOptions = Array.from(new Set(
              flats
                .filter((flat) => !invoiceStreetId || String(flat.streetId || normalizeStreetId(flat.street || flat.streetName || "")) === invoiceStreetId)
                .map((flat) => String(flat.buildingNo || flat.buildingId || "").trim())
                .filter(Boolean),
            )).sort((a, b) => a.localeCompare(b, "pl", { numeric: true }));
            const staircaseOptions = Array.from(new Set(
              flats
                .filter((flat) => {
                  const flatStreetId = String(flat.streetId || normalizeStreetId(flat.street || flat.streetName || ""));
                  const flatBuilding = String(flat.buildingNo || flat.buildingId || "").trim();
                  return (!invoiceStreetId || flatStreetId === invoiceStreetId) && (!assignment.buildingId || flatBuilding === assignment.buildingId);
                })
                .map((flat) => String(flat.staircaseId || flat.staircase || flat.entranceId || flat.entrance || flat.klatka || "").trim())
                .filter(Boolean),
            )).sort((a, b) => a.localeCompare(b, "pl", { numeric: true }));
            const flatOptions = flats
              .filter((flat) => {
                const flatStreetId = String(flat.streetId || normalizeStreetId(flat.street || flat.streetName || ""));
                const flatBuilding = String(flat.buildingNo || flat.buildingId || "").trim();
                const flatStaircase = String(flat.staircaseId || flat.staircase || flat.entranceId || flat.entrance || flat.klatka || "").trim();
                return (!invoiceStreetId || flatStreetId === invoiceStreetId)
                  && (!assignment.buildingId || flatBuilding === assignment.buildingId)
                  && (!assignment.staircaseId || flatStaircase === assignment.staircaseId);
              })
              .sort((a, b) => flatLabel(a).localeCompare(flatLabel(b), "pl", { numeric: true }));
            return (
              <div key={`${item.sourceCollection}_${item.id}`} className="card" style={{ display: "grid", gap: 12 }}>
                <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                  <strong>{String(item.supplierName || item.vendorName || item.parsed?.sellerName || item.filename || item.id)}</strong>
                  <span style={{ opacity: 0.75 }}>{moneyFromInvoice(item)}</span>
                  <span style={{ opacity: 0.75 }}>{assignment.period ? monthLabel(assignment.period) : "bez okresu"}</span>
                  <span style={{ opacity: 0.75 }}>Źródło: {item.sourceCollection === "ksefInvoices" ? "KSeF" : "Faktury"}</span>
                  <span style={{ opacity: 0.75 }}>Status: {String(item.status || "NOWA")}</span>
                </div>
                <div style={{ opacity: 0.85 }}>{String(item.parsed?.reason || item.ai?.suggestion?.reason || item.ocr?.reason || "")}</div>
                <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                  <select className="select" value={assignment.scope} onChange={(e) => updateAssignment(item.id, { scope: e.target.value, flatId: e.target.value === "FLAT" ? assignment.flatId : "", staircaseId: e.target.value === "STAIRCASE" || e.target.value === "COMMON" ? assignment.staircaseId : "" })}>
                    <option value="FLAT">FLAT · lokal</option>
                    <option value="BUILDING">BUILDING · budynek</option>
                    <option value="STAIRCASE">STAIRCASE · klatka</option>
                    <option value="COMMON">COMMON · części wspólne</option>
                    <option value="COMMUNITY">COMMUNITY · wspólnota</option>
                  </select>
                  <input className="input" placeholder="Okres YYYY-MM" value={assignment.period} onChange={(e) => updateAssignment(item.id, { period: e.target.value })} />
                  <input className="input" placeholder="Kategoria" value={assignment.category} onChange={(e) => updateAssignment(item.id, { category: e.target.value })} />
                </div>
                <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                  <select className="select" value={invoiceStreetId} onChange={(e) => {
                    const nextStreetId = e.target.value;
                    const streetName = streetOptions.find((street) => street.id === nextStreetId)?.name || assignment.streetName;
                    updateAssignment(item.id, { streetId: nextStreetId, streetName, buildingId: "", staircaseId: "", flatId: "" });
                  }}>
                    <option value="">Ulica</option>
                    {streetOptions.map((street) => <option key={street.id} value={street.id}>{street.name}</option>)}
                  </select>
                  <select className="select" value={assignment.buildingId} onChange={(e) => updateAssignment(item.id, { buildingId: e.target.value, staircaseId: "", flatId: "" })}>
                    <option value="">Budynek</option>
                    {buildingOptions.map((building) => <option key={building} value={building}>{building}</option>)}
                  </select>
                  <select className="select" value={assignment.staircaseId} onChange={(e) => updateAssignment(item.id, { staircaseId: e.target.value, flatId: "" })}>
                    <option value="">Klatka / pion</option>
                    {staircaseOptions.map((staircase) => <option key={staircase} value={staircase}>{staircase}</option>)}
                  </select>
                  <select className="select" value={assignment.flatId} onChange={(e) => {
                    const flat = flatOptions.find((candidate) => candidate.id === e.target.value);
                    updateAssignment(item.id, { flatId: e.target.value, apartmentNo: String(flat?.apartmentNo || flat?.flatNumber || assignment.apartmentNo || "") });
                  }}>
                    <option value="">Lokal</option>
                    {flatOptions.map((flat) => <option key={flat.id} value={flat.id}>{flatLabel(flat)}</option>)}
                  </select>
                </div>
                <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))" }}>
                  <input className="input" placeholder="Nazwa ulicy z OCR" value={assignment.streetName} onChange={(e) => updateAssignment(item.id, { streetName: e.target.value, streetId: assignment.streetId || normalizeStreetId(e.target.value) })} />
                  <input className="input" placeholder="Nr lokalu" value={assignment.apartmentNo} onChange={(e) => updateAssignment(item.id, { apartmentNo: e.target.value })} />
                  <div style={{ opacity: 0.78, alignSelf: "center" }}>OCR confidence: {Number(item.ocr?.confidence || item.ai?.suggestion?.confidence || 0).toFixed(2)}</div>
                </div>
                <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                  <button className="btn" disabled={busyId === item.id || uploading} onClick={() => stageInvoice(item)}>{busyId === item.id ? "Przenoszenie..." : "Przenieś do szkicu"}</button>
                  <button className="btnGhost" disabled={busyId === item.id || uploading} onClick={() => deleteInvoice(item)}>Usuń</button>
                  <div style={{ opacity: 0.78 }}>Zakres: <strong>{assignment.scope}</strong> · ID: <strong>{item.id}</strong></div>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </RequireAuth>
  );
}
