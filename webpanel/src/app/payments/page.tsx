"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, query, where, orderBy } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";

type Charge = any;

export default function PaymentsPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const role = String(profile?.role || "");
  const flatId = (profile as any)?.flatId || "";

  const [items, setItems] = useState<Charge[]>([]);

  useEffect(() => {
    if (!communityId) return;

    // Resident view (jeśli w przyszłości webpanel będzie też dla mieszkańców): filtrujemy po flatId
    if (role === "RESIDENT" && flatId) {
      const q = query(collection(db, "communities", communityId, "charges"), where("flatId", "==", flatId), orderBy("createdAtMs", "desc"));
      return onSnapshot(q, (snap) => setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))));
    }

    // Staff: pokazujemy ostatnie naliczenia bez filtra
    const q = query(collection(db, "communities", communityId, "charges"), orderBy("createdAtMs", "desc"));
    return onSnapshot(q, (snap) => setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))));
  }, [communityId, role, flatId]);

  return (
    <RequireAuth roles={["MASTER", "ADMIN", "ACCOUNTANT", "RESIDENT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <h2>Płatności</h2>
        <p style={{ opacity: 0.75 }}>
          MVP: widok naliczeń (<code>charges</code>) – saldo i płatności jako osobny moduł (TODO).
        </p>

        <div style={{ display: "grid", gap: 10 }}>
          {items.slice(0, 200).map((c) => (
            <div key={c.id} style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, display: "flex", gap: 12 }}>
              <b>{c.flatId}</b>
              <span style={{ opacity: 0.7 }}>{c.period}</span>
              <span style={{ opacity: 0.7 }}>{c.category}</span>
              <span style={{ opacity: 0.7 }}>{(Number(c.amountCents || 0) / 100).toFixed(2)} PLN</span>
            </div>
          ))}
        </div>
      </div>
    </RequireAuth>
  );
}
