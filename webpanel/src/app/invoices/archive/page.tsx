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
  const names = [
    "styczeń",
    "luty",
    "marzec",
    "kwiecień",
    "maj",
    "czerwiec",
    "lipiec",
    "sierpień",
    "wrzesień",
    "październik",
    "listopad",
    "grudzień",
  ];
  const m = String(period || "").match(/^(\d{4})-(\d{2})/);
  if (!m) return period || "bez daty";
  return `${names[Number(m[2]) - 1] || m[2]} ${m[1]}`;
}

function normalizeInvoice(
  docId: string,
  sourceCollection: "invoices" | "ksefInvoices",
  data: any
): InvoiceItem {
  return { id: docId, sourceCollection, ...(data || {}) };
}

function amountLabel(item: InvoiceItem) {
  const cents = Number(
    item?.parsed?.totalGrossCents ||
      item?.parsed?.amountCents ||
      item?.totalGrossCents ||
      item?.amountCents ||
      0
  );
  return `${(cents / 100).toFixed(2)} PLN`;
}

function monthKeyFromMs(value: unknown) {
  const ms = Number(value || 0);
  if (!(ms > 0)) return "";
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Warsaw",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(new Date(ms));
  const year = parts.find((part) => part.type === "year")?.value || "";
  const month = parts.find((part) => part.type === "month")?.value || "";
  return year && month ? `${year}-${month}` : "";
}

function monthKeyFromText(value: unknown) {
  const text = String(value || "").trim();
  const match = text.match(/^(\d{4})-(\d{2})/);
  return match ? `${match[1]}-${match[2]}` : "";
}

function archiveMonthKey(item: InvoiceItem) {
  return (
    monthKeyFromText(item.archiveMonth || item.period || item?.parsed?.period) ||
    monthKeyFromText(item.issueDate) ||
    monthKeyFromText(item?.parsed?.issueDate) ||
    monthKeyFromMs(item.archivedAtMs || item.updatedAtMs || item.createdAtMs) ||
    "inne"
  );
}

function archiveSortValue(item: InvoiceItem) {
  return Number(item.archivedAtMs || item.updatedAtMs || item.createdAtMs || 0);
}

export default function InvoiceArchivePage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [invoices, setInvoices] = useState<InvoiceItem[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [busyMonth, setBusyMonth] = useState<string>("");
  const [openMonths, setOpenMonths] = useState<Record<string, boolean>>({});

  useEffect(() => {
    if (!communityId) return;
    const unsubInvoices = onSnapshot(collection(db, "communities", communityId, "invoices"), (snap) => {
      setInvoices((prev) => {
        const other = prev.filter((item) => item.sourceCollection !== "invoices");
        return [...other, ...snap.docs.map((d) => normalizeInvoice(d.id, "invoices", d.data()))];
      });
    });
    const unsubKsef = onSnapshot(
      collection(db, "communities", communityId, "ksefInvoices"),
      (snap) => {
        setInvoices((prev) => {
          const other = prev.filter((item) => item.sourceCollection !== "ksefInvoices");
          return [...other, ...snap.docs.map((d) => normalizeInvoice(d.id, "ksefInvoices", d.data()))];
        });
      }
    );
    return () => {
      unsubInvoices();
      unsubKsef();
    };
  }, [communityId]);

  const archived = useMemo(() => {
    return invoices
      .filter(
        (item) =>
          item.isArchived === true ||
          !!item.archivedAtMs ||
          String(item.status || "").toUpperCase() === "PRZENIESIONA_DO_SZKICU"
      )
      .sort((a, b) => archiveSortValue(b) - archiveSortValue(a));
  }, [invoices]);

  const groups = useMemo(() => {
    return archived.reduce((acc: Record<string, InvoiceItem[]>, item) => {
      const key = archiveMonthKey(item);
      (acc[key] ||= []).push(item);
      return acc;
    }, {});
  }, [archived]);

  const orderedMonths = useMemo(
    () =>
      Object.keys(groups).sort((a, b) => {
        const aMax = Math.max(...(groups[a] || []).map(archiveSortValue), 0);
        const bMax = Math.max(...(groups[b] || []).map(archiveSortValue), 0);
        if (aMax !== bMax) return bMax - aMax;
        return b.localeCompare(a);
      }),
    [groups]
  );

  useEffect(() => {
    if (!orderedMonths.length) {
      setOpenMonths({});
      return;
    }

    setOpenMonths((prev) => {
      const next: Record<string, boolean> = {};
      orderedMonths.forEach((monthKey, index) => {
        next[monthKey] = Object.prototype.hasOwnProperty.call(prev, monthKey)
          ? prev[monthKey]
          : index === 0;
      });
      return next;
    });
  }, [orderedMonths]);

  const toggleMonth = (monthKey: string) => {
    setOpenMonths((prev) => ({ ...prev, [monthKey]: !prev[monthKey] }));
  };

  const clearMonth = async (monthKey: string) => {
    if (!communityId) return;
    const rows = groups[monthKey] || [];
    if (!rows.length) return;
    const ok = window.confirm(
      `Usunąć archiwum faktur za ${monthLabel(monthKey)}? Tej operacji nie można cofnąć.`
    );
    if (!ok) return;
    setBusyMonth(monthKey);
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
      setMessage(`Usunięto z archiwum ${deleted} faktur za ${monthLabel(monthKey)}.`);
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
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            gap: 12,
            alignItems: "center",
            flexWrap: "wrap",
          }}
        >
          <div>
            <h1 style={{ margin: 0 }}>Archiwum faktur</h1>
            <div style={{ opacity: 0.75 }}>Faktury przeniesione do szkiców, pogrupowane miesiącami.</div>
          </div>
          <Link
            href="/invoices"
            className="btnGhost"
            style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}
          >
            Wróć do faktur
          </Link>
        </div>

        {message ? <div style={{ color: "#8ef0c8" }}>{message}</div> : null}

        {orderedMonths.length === 0 ? (
          <div className="card">Brak archiwum faktur.</div>
        ) : (
          <div style={{ display: "grid", gap: 12 }}>
            {orderedMonths.map((monthKey) => {
              const rows = [...(groups[monthKey] || [])].sort(
                (a, b) => archiveSortValue(b) - archiveSortValue(a)
              );
              const open = !!openMonths[monthKey];
              return (
                <div key={monthKey} className="card" style={{ display: "grid", gap: 12 }}>
                  <button
                    type="button"
                    className="btnGhost"
                    onClick={() => toggleMonth(monthKey)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: 12,
                    }}
                  >
                    <span>
                      {open ? "▾" : "▸"} {monthLabel(monthKey)}
                    </span>
                    <span>{rows.length}</span>
                  </button>

                  {open ? (
                    <>
                      <div
                        style={{
                          display: "flex",
                          justifyContent: "space-between",
                          gap: 12,
                          alignItems: "center",
                          flexWrap: "wrap",
                        }}
                      >
                        <strong>{monthLabel(monthKey)}</strong>
                        <button
                          className="btnGhost"
                          onClick={() => clearMonth(monthKey)}
                          disabled={busyMonth === monthKey}
                        >
                          {busyMonth === monthKey ? "Czyszczenie..." : "Wyczyść miesiąc"}
                        </button>
                      </div>

                      <div style={{ display: "grid", gap: 10 }}>
                        {rows.map((item) => (
                          <div
                            key={`${item.sourceCollection}_${item.id}`}
                            style={{
                              display: "flex",
                              justifyContent: "space-between",
                              gap: 12,
                              flexWrap: "wrap",
                              borderTop: "1px solid rgba(255,255,255,.08)",
                              paddingTop: 10,
                            }}
                          >
                            <div style={{ display: "grid", gap: 4 }}>
                              <strong>
                                {String(
                                  item.supplierName ||
                                    item.vendorName ||
                                    item.parsed?.sellerName ||
                                    item.filename ||
                                    item.id
                                )}
                              </strong>
                              <div style={{ opacity: 0.78 }}>
                                Kategoria: {String(item.category || item.parsed?.category || "INNE")} ·
                                Zakres: {String(
                                  item.assigned?.scope ||
                                    item.scope ||
                                    item.parsed?.scope ||
                                    item.parsed?.allocationType ||
                                    "—"
                                )}
                              </div>
                              <div style={{ opacity: 0.78 }}>
                                Okres: {String(
                                  item.lastDraftPeriod || item.period || item.parsed?.period || "—"
                                )} · Szkice: {Number(item.settlementDraftCount || 0)}
                              </div>
                              <div style={{ opacity: 0.7 }}>
                                Źródło: {item.sourceCollection === "ksefInvoices" ? "KSeF" : "Faktury"} · ID: {item.id}
                              </div>
                            </div>
                            <div style={{ fontWeight: 700 }}>{amountLabel(item)}</div>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </RequireAuth>
  );
}
