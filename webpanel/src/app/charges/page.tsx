"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { collection, getDocs, onSnapshot, orderBy, query } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";
import { buildFlatLabel } from "../../lib/flatMapping";

type Settlement = any;

function money(v: any) {
  return `${Number(v || 0).toFixed(2)} PLN`;
}

function centsOrAmount(cents: any, amount: any) {
  if (cents != null) return Number(cents) / 100;
  return Number(amount || 0);
}

export default function ChargesPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [items, setItems] = useState<Settlement[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [flatLabels, setFlatLabels] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!communityId) return;
    const q = query(collection(db, "communities", communityId, "settlements"), orderBy("updatedAtMs", "desc"));
    return onSnapshot(q, async (snap) => {
      const data = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
      setItems(data);
      const missing = Array.from(new Set(data.map((item: any) => String(item.flatId || "").trim()).filter(Boolean))).filter((flatId) => !flatLabels[flatId]);
      if (!missing.length) return;
      const flatSnap = await getDocs(collection(db, "communities", communityId, "flats"));
      const labelMap: Record<string, string> = {};
      flatSnap.docs.forEach((docSnap) => {
        const flat: any = docSnap.data() || {};
        labelMap[docSnap.id] = String(flat.flatLabel || buildFlatLabel(flat.street, flat.buildingNo, flat.apartmentNo) || docSnap.id);
      });
      setFlatLabels((prev) => ({ ...prev, ...labelMap }));
    });
  }, [communityId]);

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <h2>Rozliczenia lokali</h2>
        <p style={{ opacity: 0.8, marginTop: -8 }}>Po utworzeniu lub aktualizacji rozliczenia lokator z aplikacją widzi bieżący miesiąc w kafelku "Rozliczenia" wraz z kwotą, terminem i danymi do przelewu.</p>
        {msg && <div style={{ color: "green" }}>{msg}</div>}

        <div style={{ display: "grid", gap: 10 }}>
          {items.slice(0, 200).map((s) => (
            <div key={s.id} className="card" style={{ display: "grid", gap: 10 }}>
              <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <b>{flatLabels[String(s.flatId || "")] || s.flatLabel || s.flatId || "Lokal"}</b>
                <span style={{ opacity: 0.75 }}>{s.period}</span>
                <span style={{ opacity: 0.75 }}>Saldo: {money(centsOrAmount(s.balanceCents, s.balance))}</span>
                <span style={{ opacity: 0.75 }}>Opłaty: {money(centsOrAmount(s.chargesCents ?? s.totalCents, s.total))}</span>
                <span style={{ opacity: 0.75 }}>Wpłaty: {money(centsOrAmount(s.paymentsCents, s.payments))}</span>
              </div>
              <div style={{ display: "grid", gap: 4, opacity: 0.9 }}>
                <div>Termin płatności: {s.dueDate || "—"}</div>
                <div>Rachunek: {s.accountNumber || "—"}</div>
                <div>Tytuł przelewu: {s.transferTitle || "—"}</div>
              </div>
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
                <Link href={`/settlements/${s.id}`} className="btn" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                  Otwórz podgląd
                </Link>
                <button className="btnGhost" onClick={async () => {
                  const url = `/api/settlements/${s.id}/pdf?communityId=${encodeURIComponent(communityId)}`;
                  window.open(url, "_blank");
                  setMsg("PDF gotowy.");
                }}>PDF</button>
                <button className="btnGhost" onClick={async () => {
                  const res = await fetch(`/api/settlements/${s.id}/send-email`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ communityId }),
                  });
                  const data = await res.json();
                  setMsg(res.ok ? `Email wysłany do: ${data.email || "—"}` : `Błąd email: ${data.error || "nieznany"}`);
                }}>Wyślij email</button>
              </div>
            </div>
          ))}
        </div>
        <div style={{ opacity: 0.65 }}>Podgląd: max 200 ostatnich rozliczeń.</div>
      </div>
    </RequireAuth>
  );
}
