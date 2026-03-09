"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, getDocs, orderBy, query, where } from "firebase/firestore";
import { db } from "@/lib/firebase";
import Link from "next/link";

type Invoice = {
  id: string;
  vendor?: string;
  number?: string;
  title?: string;
  archiveMonth?: string;
  period?: string;
  totalGross?: number;
  amount?: number;
  category?: string;
};

export default function InvoicesArchivePage() {
  const [items, setItems] = useState<Invoice[]>([]);

  useEffect(() => {
    const communityId = typeof window !== "undefined" ? localStorage.getItem("communityId") || "" : "";
    if (!communityId) return;
    getDocs(query(collection(db, `communities/${communityId}/invoices`), where("archived", "==", true), orderBy("archiveMonth", "desc"))).then((snap) => {
      setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })));
    });
  }, []);

  const grouped = useMemo(() => {
    const map: Record<string, Invoice[]> = {};
    for (const item of items) {
      const key = item.archiveMonth || item.period || "bez-miesiąca";
      map[key] ||= [];
      map[key].push(item);
    }
    return Object.entries(map).sort((a, b) => b[0].localeCompare(a[0]));
  }, [items]);

  return (
    <main className="max-w-5xl mx-auto p-6 text-white">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-3xl font-bold">Archiwum faktur</h1>
        <Link className="px-4 py-2 rounded-xl border border-white/20" href="/invoices">Powrót do faktur</Link>
      </div>
      <div className="space-y-6">
        {grouped.map(([month, rows]) => (
          <section key={month} className="rounded-2xl border border-white/10 p-4 bg-black/10">
            <h2 className="text-xl font-semibold mb-3">{month}</h2>
            <div className="space-y-3">
              {rows.map((item) => (
                <div key={item.id} className="rounded-xl border border-white/10 p-4 flex items-center justify-between gap-4">
                  <div>
                    <div className="font-semibold">{item.vendor || item.title || "Faktura"}</div>
                    <div className="text-sm opacity-80">{item.number || item.id} • {item.category || "bez kategorii"}</div>
                  </div>
                  <div className="font-semibold">{Number(item.totalGross || item.amount || 0).toFixed(2)} PLN</div>
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </main>
  );
}
