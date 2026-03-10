"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { RequireAuth } from "../../../../components/RequireAuth";
import { Nav } from "../../../../components/Nav";
import { useAuth } from "../../../../lib/authContext";
import { db } from "../../../../lib/firebase";

type Invoice = any;

const fromCents = (c: unknown) => (Number(c || 0) / 100).toFixed(2);
const categoryLabel = (v: unknown) => ({
  PRAD: "PRĄD",
  WODA: "WODA",
  GAZ: "GAZ",
  SPRZATANIE: "SPRZĄTANIE",
  REMONT: "REMONT",
} as any)[String(v || "").toUpperCase()] || String(v || "INNE");

export default function InvoicesArchivePage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [items, setItems] = useState<Invoice[]>([]);

  useEffect(() => {
    if (!communityId) return;
    let invItems: Invoice[] = [];
    let ksefItems: Invoice[] = [];
    const merge = () => setItems([...invItems, ...ksefItems].sort((a, b) => String(b.archiveMonth || b.period || "").localeCompare(String(a.archiveMonth || a.period || ""))));

    const u1 = onSnapshot(query(collection(db, "communities", communityId, "invoices"), orderBy("createdAtMs", "desc")), (snap) => {
      invItems = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any), _sourceCollection: "invoices" }));
      merge();
    });
    const u2 = onSnapshot(query(collection(db, "communities", communityId, "ksefInvoices"), orderBy("createdAtMs", "desc")), (snap) => {
      ksefItems = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any), _sourceCollection: "ksefInvoices" }));
      merge();
    });

    return () => {
      u1();
      u2();
    };
  }, [communityId]);

  const groups = useMemo(() => {
    const archived = items.filter((x) => !x.deletedAtMs && !!x.archivedAtMs && String(x.status || "").toUpperCase() !== "DELETED");
    return archived.reduce((acc: Record<string, Invoice[]>, x: Invoice) => {
      const key = String(x.archiveMonth || x.parsed?.period || x.period || "bez-daty");
      (acc[key] ||= []).push(x);
      return acc;
    }, {});
  }, [items]);

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <h2>Archiwum faktur</h2>
          <Link href="/invoices" className="btnGhost" style={{ textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
            Powrót do faktur
          </Link>
        </div>

        <div className="card" style={{ display: "grid", gap: 12 }}>
          <h3>Faktury zarchiwizowane według miesięcy</h3>
          {Object.keys(groups).length === 0 ? (
            <div style={{ opacity: 0.7 }}>Brak archiwum faktur.</div>
          ) : (
            Object.entries(groups)
              .sort((a, b) => String(b[0]).localeCompare(String(a[0])))
              .map(([period, rows]) => (
                <div key={period} style={{ display: "grid", gap: 8 }}>
                  <strong>{period}</strong>
                  {rows.map((inv: any) => (
                    <div key={`${inv._sourceCollection || "invoices"}-${inv.id}`} className="card" style={{ display: "grid", gap: 8 }}>
                      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
                        <strong>{inv.vendorName || "Faktura"}</strong>
                        <span>{inv.title || inv.id}</span>
                        <span>{fromCents(inv.totalGrossCents || inv.parsed?.amountCents || 0)} PLN</span>
                        <span>{categoryLabel(inv.category || inv.parsed?.category)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              ))
          )}
        </div>
      </div>
    </RequireAuth>
  );
}
