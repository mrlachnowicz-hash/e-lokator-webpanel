"use client";

import { useEffect, useState } from "react";
import Nav from "@/components/Nav";
import RequireAuth from "@/components/RequireAuth";
import { db } from "@/lib/firebase";
import { collection, getDocs } from "firebase/firestore";

type Invoice = {
  id: string;
  supplier: string;
  amount: number;
  archiveMonth?: string;
  period?: string;
};

export default function InvoiceArchivePage() {
  const [invoices, setInvoices] = useState<Record<string, Invoice[]>>({});

  useEffect(() => {
    const load = async () => {
      const snap = await getDocs(collection(db, "invoices"));
      const grouped: Record<string, Invoice[]> = {};

      snap.docs.forEach((doc) => {
        const data = doc.data() as Invoice;
        const month = data.archiveMonth || data.period || "inne";

        if (!grouped[month]) grouped[month] = [];

        grouped[month].push({
          id: doc.id,
          ...data,
        });
      });

      setInvoices(grouped);
    };

    load();
  }, []);

  return (
    <RequireAuth>
      <Nav />

      <div className="max-w-6xl mx-auto px-6 py-8 text-white">
        <h1 className="text-2xl font-semibold mb-6">Archiwum faktur</h1>

        {Object.entries(invoices).map(([month, items]) => (
          <div key={month} className="mb-8">
            <h2 className="text-lg font-semibold mb-3">{month}</h2>

            <div className="space-y-2">
              {items.map((inv) => (
                <div
                  key={inv.id}
                  className="rounded-xl border border-white/10 p-4 flex justify-between"
                >
                  <span>{inv.supplier}</span>
                  <span>{inv.amount} PLN</span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </RequireAuth>
  );
}
