"use client";

import { useEffect, useMemo, useState } from "react";
import { doc, getDoc } from "firebase/firestore";
import { useParams } from "next/navigation";
import { Nav } from "../../../components/Nav";
import { RequireAuth } from "../../../components/RequireAuth";
import { useAuth } from "../../../lib/authContext";
import { db } from "../../../lib/firebase";

type SettlementLine = {
  label?: string;
  name?: string;
  title?: string;
  category?: string;
  amount?: number;
  amountCents?: number;
  value?: number;
};

type SettlementDoc = {
  period?: string;
  monthLabel?: string;
  flatId?: string;
  flatLabel?: string;
  residentName?: string;
  ownerName?: string;
  dueDate?: string;
  dueDateText?: string;
  bankAccount?: string;
  bankAccountNumber?: string;
  transferTitle?: string;
  paymentTitle?: string;
  total?: number;
  totalAmount?: number;
  totalCents?: number;
  amountDue?: number;
  amountDueCents?: number;
  charges?: SettlementLine[];
  items?: SettlementLine[];
};

function centsToPln(value: unknown): string {
  const n = Number(value || 0);
  return `${(n / 100).toFixed(2)} PLN`;
}

function amountToText(line: SettlementLine): string {
  if (line.amountCents != null) return centsToPln(line.amountCents);
  if (line.amount != null) return `${Number(line.amount).toFixed(2)} PLN`;
  if (line.value != null) return `${Number(line.value).toFixed(2)} PLN`;
  return "0.00 PLN";
}

export default function SettlementDetailsPage() {
  const params = useParams();
  const settlementId = String(params?.settlementId || "");
  const { profile } = useAuth();
  const communityId = String(profile?.communityId || "");
  const [item, setItem] = useState<SettlementDoc | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function load() {
      if (!communityId || !settlementId) {
        setLoading(false);
        return;
      }
      setLoading(true);
      setError(null);
      try {
        const snap = await getDoc(doc(db, "communities", communityId, "settlements", settlementId));
        if (!active) return;
        if (!snap.exists()) {
          setItem(null);
          setError("Nie znaleziono rozliczenia.");
        } else {
          setItem(snap.data() as SettlementDoc);
        }
      } catch (e: any) {
        if (!active) return;
        setItem(null);
        setError(String(e?.message || "Nie udało się wczytać rozliczenia."));
      } finally {
        if (active) setLoading(false);
      }
    }

    load();
    return () => {
      active = false;
    };
  }, [communityId, settlementId]);

  const lines = useMemo(() => item?.charges || item?.items || [], [item]);
  const period = item?.monthLabel || item?.period || "Rozliczenie";
  const dueDate = item?.dueDateText || item?.dueDate || "—";
  const bankAccount = item?.bankAccount || item?.bankAccountNumber || "—";
  const transferTitle = item?.transferTitle || item?.paymentTitle || `EL-${item?.flatId || ""}-${item?.period || ""}`;
  const totalText = item?.totalCents != null
    ? centsToPln(item.totalCents)
    : item?.amountDueCents != null
      ? centsToPln(item.amountDueCents)
      : item?.total != null
        ? `${Number(item.total).toFixed(2)} PLN`
        : item?.amountDue != null
          ? `${Number(item.amountDue).toFixed(2)} PLN`
          : "0.00 PLN";

  const copyTransferData = async () => {
    const text = `Nr konta: ${bankAccount}\nKwota: ${totalText}\nTytuł przelewu: ${transferTitle}`;
    await navigator.clipboard.writeText(text);
    alert("Dane do przelewu skopiowane.");
  };

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16, maxWidth: 960 }}>
        <h2 style={{ margin: 0 }}>Rozliczenie lokalu</h2>

        {loading ? <div className="card">Ładowanie…</div> : null}
        {!loading && error ? <div className="card" style={{ color: "#ff8080" }}>{error}</div> : null}

        {!loading && !error && item ? (
          <>
            <div className="card" style={{ display: "grid", gap: 10 }}>
              <h3 style={{ margin: 0 }}>{period}</h3>
              <div><b>Lokal:</b> {item.flatLabel || item.flatId || "—"}</div>
              <div><b>Lokator:</b> {item.residentName || item.ownerName || "—"}</div>
              <div><b>Termin płatności:</b> {dueDate}</div>
            </div>

            <div className="card" style={{ display: "grid", gap: 10 }}>
              <h3 style={{ margin: 0 }}>Pozycje rozliczenia</h3>
              {lines.length ? lines.map((line, idx) => (
                <div key={idx} style={{ display: "flex", justifyContent: "space-between", gap: 12, borderBottom: "1px solid rgba(255,255,255,.08)", paddingBottom: 8 }}>
                  <span>{line.label || line.name || line.title || line.category || `Pozycja ${idx + 1}`}</span>
                  <span>{amountToText(line)}</span>
                </div>
              )) : <div style={{ opacity: 0.75 }}>Brak rozpisanych pozycji w dokumencie settlement.</div>}

              <div style={{ display: "flex", justifyContent: "space-between", marginTop: 8, fontWeight: 700, fontSize: 18 }}>
                <span>Suma do zapłaty</span>
                <span>{totalText}</span>
              </div>
            </div>

            <div className="card" style={{ display: "grid", gap: 10 }}>
              <h3 style={{ margin: 0 }}>Dane do przelewu</h3>
              <div><b>Numer konta:</b> {bankAccount}</div>
              <div><b>Kwota:</b> {totalText}</div>
              <div><b>Tytuł przelewu:</b> {transferTitle}</div>
              <div>
                <button className="btn" onClick={copyTransferData}>Kopiuj dane przelewu</button>
              </div>
            </div>
          </>
        ) : null}
      </div>
    </RequireAuth>
  );
}
