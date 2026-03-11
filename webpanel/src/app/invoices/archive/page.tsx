"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { collection, doc, onSnapshot, writeBatch } from "firebase/firestore";
import { db } from "@/lib/firebase";
import { useAuth } from "@/lib/authContext";
import { Nav } from "@/components/Nav";
import { RequireAuth } from "@/components/RequireAuth";

type InvoiceItem = any & { id: string; sourceCollection: "invoices" | "ksefInvoices" };

function monthLabel(period: string) {
  const names = ["styczeń", "luty", "marzec", "kwiecień", "maj", "czerwiec", "lipiec", "sierpień", "wrzesień", "październik", "listopad", "grudzień"];
  const m = String(period || "").match(/^(\d{4})-(\d{2})/);
  if (!m) return period || "bez daty";
  return `${names[Number(m[2]) - 1] || m[2]} ${m[1]}`;
}

function normalizeInvoice(docId: string, sourceCollection: "invoices" | "ksefInvoices", data: any): InvoiceItem {
  return { id: docId, sourceCollection, ...(data || {}) };
}

function amountLabel(item: InvoiceItem) {
  const cents = Number(item?.parsed?.totalGrossCents || item?.parsed?.amountCents || item?.totalGrossCents || item?.amountCents || 0);
  return `${(cents / 100).toFixed(2)} PLN`;
}

function archiveKey(item: InvoiceItem) {
  return String(item.archiveMonth || item.period || item?.parsed?.period || item.issueDate?.slice?.(0, 7) || "inne").trim() || "inne";
}

export default function InvoiceArchivePage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [invoices, setInvoices] = useState<InvoiceItem[]>([]);
  const [openMonth, setOpenMonth] = useState<string>("");
  const [message, setMessage] = useState<string | null>(null);
  const [busyMonth, setBusyMonth] = useState<string>("");

  useEffect(() => {
    if (!communityId) return;
    const unsubInvoices = onSnapshot(collection(db, "communities", communityId, "invoices"), (snap) => {
      setInvoices((prev) => {
        const other = prev.filter((item) => item.sourceCollection !== "invoices");
        return [...other, ...snap.docs.map((d) => normalizeInvoice(d.id, "invoices", d.data()))];
      });
    });
    const unsubKsef = onSnapshot(collection(db, "communities", communityId, "ksefInvoices"), (snap) => {
      setInvoices((prev) => {
        const other = prev.filter((item) => item.sourceCollection !== "ksefInvoices");
        return [...other, ...snap.docs.map((d) => normalizeInvoice(d.id, "ksefInvoices", d.data()))];
      });
    });
    return () => {
      unsubInvoices();
      unsubKsef();
    };
  }, [communityId]);

  const archived = useMemo(() => {
    return invoices
      .filter((item) => item.isArchived === true || !!item.archivedAtMs || String(item.status || "").toUpperCase() === "PRZENIESIONA_DO_SZKICU")
      .sort((a, b) => Number(b.archivedAtMs || b.updatedAtMs || b.createdAtMs || 0) - Number(a.archivedAtMs || a.updatedAtMs || a.createdAtMs || 0));
  }, [invoices]);

  const groups = useMemo(() => {
    return archived.reduce((acc: Record<string, InvoiceItem[]>, item) => {
      const key = archiveKey(item);
      (acc[key] ||= []).push(item);
      return acc;
    }, {});
  }, [archived]);

  const orderedMonths = useMemo(() => Object.keys(groups).sort((a, b) => b.localeCompare(a)), [groups]);

  useEffect(() => {
    if (!orderedMonths.length) {
      setOpenMonth("");
      return;
    }
    if (openMonth && !groups[openMonth]) setOpenMonth("");
  }, [groups, orderedMonths, openMonth]);

  const clearMonth = async (month: string) => {
    if (!communityId) return;
    const rows = groups[month] || [];
    if (!rows.length) return;
    const ok = window.confirm(`Usunąć archiwum faktur za ${monthLabel(month)}? Tej operacji nie można cofnąć.`);
    if (!ok) return;
    setBusyMonth(month);
    setMessage(null);
    try {
      let deleted = 0;
      let batch = writeBatch(db);
      let ops = 0;
      for (const item of rows) {
        batch.delete(doc(db, "communities", communityId, item.sourceCollection, item.id));
        deleted += 1;
        ops += 1;
        if (ops >= 450) {
          await batch.commit();
          batch = writeBatch(db);
          ops = 0;
        }
      }
      if (ops > 0) await batch.commit();
      setMessage(`Usunięto z archiwum ${deleted} faktur za ${monthLabel(month)}.`);
      if (openMonth === month) {
        setOpenMonth("");
      }
    } catch (error: any) {
      setMessage(error?.message || "Błąd usuwania archiwum miesiąca.");
    } finally {
      setBusyMonth("");
    }
  };

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
          <div>
            <h1 style={{ margin: 0 }}>Archiwum faktur</h1>
            <div style={{ opacity: 0.75 }}>Faktury przeniesione do szkiców rozliczeń.</div>
          </div>
          <Link href="/invoices" className="btnGhost" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>Wróć do faktur</Link>
        </div>

        {message ? <div style={{ color: "#8ef0c8" }}>{message}</div> : null}

        {orderedMonths.length === 0 ? <div className="card">Brak archiwum faktur.</div> : (
          <>
            <div className="card" style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
              {orderedMonths.map((month) => {
                const isOpen = openMonth === month;
                return (
                  <button
                    key={month}
                    type="button"
                    className={isOpen ? "btn" : "btnGhost"}
                    onClick={() => setOpenMonth(isOpen ? "" : month)}
                  >
                    {isOpen ? "▾" : "▸"} {monthLabel(month)} ({groups[month]?.length || 0})
                  </button>
                );
              })}
            </div>

            {orderedMonths.map((month) => {
              if (openMonth !== month) return null;
              return (
                <div key={`panel_${month}`} className="card" style={{ display: "grid", gap: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                    <strong>{monthLabel(month)}</strong>
                    <button className="btnGhost" onClick={() => clearMonth(month)} disabled={busyMonth === month}>
                      {busyMonth === month ? "Czyszczenie..." : "Wyczyść miesiąc"}
                    </button>
                  </div>
                  <div style={{ display: "grid", gap: 10 }}>
                    {groups[month].map((item) => (
                      <div key={`${item.sourceCollection}_${item.id}`} style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", borderTop: "1px solid rgba(255,255,255,.08)", paddingTop: 10 }}>
                        <div style={{ display: "grid", gap: 4 }}>
                          <strong>{String(item.supplierName || item.vendorName || item.parsed?.sellerName || item.filename || item.id)}</strong>
                          <div style={{ opacity: 0.78 }}>Kategoria: {String(item.category || item.parsed?.category || "INNE")} · Zakres: {String(item.assigned?.scope || item.scope || item.parsed?.scope || item.parsed?.allocationType || "—")}</div>
                          <div style={{ opacity: 0.78 }}>Okres: {String(item.lastDraftPeriod || item.period || item.parsed?.period || "—")} · Szkice: {Number(item.settlementDraftCount || 0)}</div>
                          <div style={{ opacity: 0.7 }}>Źródło: {item.sourceCollection === "ksefInvoices" ? "KSeF" : "Faktury"} · ID: {item.id}</div>
                        </div>
                        <div style={{ fontWeight: 700 }}>{amountLabel(item)}</div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </>
        )}
      </div>
    </RequireAuth>
  );
}
