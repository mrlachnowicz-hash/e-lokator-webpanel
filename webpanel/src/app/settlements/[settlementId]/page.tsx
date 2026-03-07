"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { collection, doc, getDoc, onSnapshot, orderBy, query } from "firebase/firestore";
import { Nav } from "../../../components/Nav";
import { RequireAuth } from "../../../components/RequireAuth";
import { useAuth } from "../../../lib/authContext";
import { db } from "../../../lib/firebase";
import { callable } from "../../../lib/functions";

type ChargeItem = {
  label?: string;
  amount?: number;
  amountCents?: number;
};

type Settlement = {
  id?: string;
  flatId?: string;
  residentName?: string;
  period?: string;
  dueDate?: string;
  bankAccount?: string;
  accountNumber?: string;
  transferTitle?: string;
  total?: number;
  totalCents?: number;
  balanceCents?: number;
  charges?: ChargeItem[];
  chargesBreakdown?: ChargeItem[];
};

type Payment = {
  id: string;
  date?: string;
  bookingDate?: string;
  title?: string;
  source?: string;
  amount?: number;
  amountCents?: number;
  matched?: boolean;
  matchedBy?: string;
  status?: string;
  settlementId?: string;
  flatId?: string;
  period?: string;
  transferTitle?: string;
};

type ReviewItem = {
  id: string;
  title?: string;
  description?: string;
  type?: string;
  status?: string;
  flatId?: string;
  settlementId?: string;
  period?: string;
  amount?: number;
  amountCents?: number;
};

const MONTHS_PL = [
  "Styczeń", "Luty", "Marzec", "Kwiecień", "Maj", "Czerwiec",
  "Lipiec", "Sierpień", "Wrzesień", "Październik", "Listopad", "Grudzień",
];

function formatMoney(value: number | string | null | undefined) {
  const n = Number(value || 0);
  return `${n.toFixed(2).replace(/\.00$/, "")} zł`;
}

function normalizeChargeAmount(item: ChargeItem) {
  if (item.amountCents != null) return Number(item.amountCents) / 100;
  return Number(item.amount || 0);
}

function formatPeriod(period?: string) {
  if (!period) return "—";
  const m = String(period).match(/^(\d{4})-(\d{2})$/);
  if (!m) return String(period);
  const year = Number(m[1]);
  const monthIndex = Number(m[2]) - 1;
  return `${MONTHS_PL[monthIndex] || m[2]} ${year}`;
}

function formatDate(value?: string) {
  if (!value) return "—";
  const text = String(value);
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[3]}.${iso[2]}.${iso[1]}`;
  return text;
}

function normalizeStatus(raw?: string) {
  const value = String(raw || "").toUpperCase();
  if (value === "CODE") return { code: "CODE", label: "dopasowane" };
  if (value === "AI_HINT" || value === "AI") return { code: "AI_HINT", label: "dopasowane AI" };
  if (value === "REVIEW") return { code: "REVIEW", label: "do sprawdzenia" };
  if (value === "MATCHED") return { code: "CODE", label: "dopasowane" };
  return { code: value || "REVIEW", label: value || "do sprawdzenia" };
}

function inferPaymentStatus(p: Payment) {
  const direct = normalizeStatus(p.status || p.matchedBy);
  if (direct.code && direct.code !== "REVIEW") return direct;
  if (String(p.matchedBy || "").toUpperCase().includes("AI")) return normalizeStatus("AI_HINT");
  if (p.matched) return normalizeStatus("CODE");
  return normalizeStatus("REVIEW");
}

export default function SettlementDetailsPage({ params }: { params: { settlementId: string } }) {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const settlementId = params.settlementId;
  const [settlement, setSettlement] = useState<Settlement | null>(null);
  const [loadingSettlement, setLoadingSettlement] = useState(true);
  const [payments, setPayments] = useState<Payment[]>([]);
  const [reviewItems, setReviewItems] = useState<ReviewItem[]>([]);
  const [transferOpen, setTransferOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!communityId || !settlementId) return;
    let active = true;

    setLoadingSettlement(true);
    (async () => {
      const ref = doc(db, "communities", communityId, "settlements", settlementId);
      const snap = await getDoc(ref);
      if (!active) return;
      setSettlement(snap.exists() ? ({ id: snap.id, ...(snap.data() as Settlement) }) : null);
      setLoadingSettlement(false);
    })();

    const paymentsRef = query(collection(db, "communities", communityId, "payments"), orderBy("createdAtMs", "desc"));
    const unsubPayments = onSnapshot(paymentsRef, (snap) => {
      setPayments(snap.docs.map((d) => ({ ...(d.data() as Payment), id: d.id })));
    });

    const reviewRef = query(collection(db, "communities", communityId, "reviewQueue"), orderBy("createdAtMs", "desc"));
    const unsubReview = onSnapshot(reviewRef, (snap) => {
      setReviewItems(snap.docs.map((d) => ({ ...(d.data() as ReviewItem), id: d.id })));
    });

    return () => {
      active = false;
      unsubPayments();
      unsubReview();
    };
  }, [communityId, settlementId]);

  const charges = useMemo(() => {
    const list = settlement?.charges || settlement?.chargesBreakdown || [];
    return Array.isArray(list) ? list : [];
  }, [settlement]);

  const total = useMemo(() => {
    if (!settlement) return 0;
    if (settlement.totalCents != null) return Number(settlement.totalCents) / 100;
    if (settlement.total != null) return Number(settlement.total);
    if (settlement.balanceCents != null) return Number(settlement.balanceCents) / 100;
    return charges.reduce((sum, item) => sum + normalizeChargeAmount(item), 0);
  }, [charges, settlement]);

  const relatedPayments = useMemo(() => {
    if (!settlement) return [];
    const transferTitle = String(settlement.transferTitle || "").toLowerCase();
    const flatId = String(settlement.flatId || "").toLowerCase();
    const period = String(settlement.period || "").toLowerCase();
    return payments.filter((p) => {
      const title = `${p.title || ""} ${p.source || ""} ${p.transferTitle || ""}`.toLowerCase();
      return p.settlementId === settlementId
        || (!!flatId && String(p.flatId || "").toLowerCase() === flatId)
        || (!!transferTitle && title.includes(transferTitle))
        || (!!period && !!flatId && String(p.period || "").toLowerCase() === period && title.includes(flatId));
    }).slice(0, 20);
  }, [payments, settlement, settlementId]);

  const relatedReview = useMemo(() => {
    if (!settlement) return [];
    const flatId = String(settlement.flatId || "");
    const period = String(settlement.period || "");
    return reviewItems.filter((item) => item.settlementId === settlementId || (item.flatId === flatId && item.period === period)).slice(0, 20);
  }, [reviewItems, settlement, settlementId]);

  const bankAccount = settlement?.bankAccount || settlement?.accountNumber || "—";
  const transferTitle = settlement?.transferTitle || "—";

  return (
    <RequireAuth roles={["MASTER", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
          <div>
            <div style={{ opacity: 0.75, marginBottom: 6 }}>Rozliczenie</div>
            <h1 style={{ margin: 0 }}>{formatPeriod(settlement?.period)}</h1>
          </div>
          <Link href="/charges" className="btnGhost" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
            Wróć do rozliczeń
          </Link>
        </div>

        {loadingSettlement ? (
          <div className="card">Ładowanie...</div>
        ) : !settlement ? (
          <div className="card">Nie znaleziono rozliczenia.</div>
        ) : (
          <>
            <div className="card" style={{ maxWidth: 760, display: "grid", gap: 18 }}>
              <div style={{ display: "grid", gap: 6 }}>
                <div><strong>Lokal:</strong> {settlement.flatId || "—"}</div>
                <div><strong>Lokator:</strong> {settlement.residentName || "—"}</div>
              </div>

              <div style={{ borderTop: "1px solid rgba(255,255,255,.12)", paddingTop: 16, display: "grid", gap: 10 }}>
                {charges.length === 0 ? <div style={{ opacity: 0.7 }}>Brak pozycji rozliczenia.</div> : null}
                {charges.map((charge, index) => (
                  <div key={`${charge.label || "poz"}-${index}`} style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                    <span>{charge.label || `Pozycja ${index + 1}`}</span>
                    <strong>{formatMoney(normalizeChargeAmount(charge))}</strong>
                  </div>
                ))}
              </div>

              <div style={{ borderTop: "1px solid rgba(255,255,255,.12)", paddingTop: 16, display: "flex", justifyContent: "space-between", gap: 12, fontSize: 18 }}>
                <strong>SUMA DO ZAPŁATY</strong>
                <strong>{formatMoney(total)}</strong>
              </div>

              <div style={{ display: "grid", gap: 6 }}>
                <div><strong>Termin płatności:</strong> {formatDate(settlement.dueDate)}</div>
              </div>

              <div style={{ borderTop: "1px solid rgba(255,255,255,.12)", paddingTop: 16, display: "flex", gap: 10, flexWrap: "wrap" }}>
                <button className="btn" onClick={() => setTransferOpen(true)}>Dane do przelewu</button>
                <button className="btnGhost" onClick={async () => {
                  const res = await callable<any, any>("generateSettlementPdf")({ communityId, settlementId });
                  const url = String((res.data as any)?.pdfUrl || "");
                  if (url) window.open(url, "_blank");
                  setMessage(url ? "PDF został wygenerowany." : "Nie udało się pobrać PDF.");
                }}>Pobierz PDF</button>
                <button className="btnGhost" onClick={async () => {
                  const res = await callable<any, any>("sendSettlementEmail")({ communityId, settlementId });
                  const email = String((res.data as any)?.email || "");
                  setMessage(email ? `Email zakolejkowany do: ${email}` : "Email został zakolejkowany.");
                }}>Wyślij email</button>
              </div>

              {message ? <div style={{ color: "#8ef0c8", fontWeight: 700 }}>{message}</div> : null}
            </div>

            <div className="card" style={{ maxWidth: 960, display: "grid", gap: 12 }}>
              <h3 style={{ margin: 0 }}>Import przelewów</h3>
              <div style={{ opacity: 0.78 }}>System pokazuje ostatnie dopasowania do tego rozliczenia wraz ze statusem CODE / AI_HINT / REVIEW.</div>
              <div style={{ overflowX: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse" }}>
                  <thead>
                    <tr style={{ textAlign: "left", opacity: 0.72 }}>
                      <th style={{ padding: "10px 8px" }}>DATA</th>
                      <th style={{ padding: "10px 8px" }}>KWOTA</th>
                      <th style={{ padding: "10px 8px" }}>TYTUŁ</th>
                      <th style={{ padding: "10px 8px" }}>STATUS</th>
                    </tr>
                  </thead>
                  <tbody>
                    {relatedPayments.length === 0 ? (
                      <tr>
                        <td colSpan={4} style={{ padding: "12px 8px", opacity: 0.72 }}>Brak dopasowanych przelewów dla tego rozliczenia.</td>
                      </tr>
                    ) : relatedPayments.map((payment) => {
                      const status = inferPaymentStatus(payment);
                      return (
                        <tr key={payment.id} style={{ borderTop: "1px solid rgba(255,255,255,.08)" }}>
                          <td style={{ padding: "12px 8px" }}>{formatDate(payment.date || payment.bookingDate)}</td>
                          <td style={{ padding: "12px 8px" }}>{formatMoney(payment.amountCents != null ? Number(payment.amountCents) / 100 : payment.amount)}</td>
                          <td style={{ padding: "12px 8px" }}>{payment.title || payment.source || "—"}</td>
                          <td style={{ padding: "12px 8px" }}>{status.code} · {status.label}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="card" style={{ maxWidth: 960, display: "grid", gap: 12 }}>
              <h3 style={{ margin: 0 }}>Review queue</h3>
              {relatedReview.length === 0 ? (
                <div style={{ opacity: 0.72 }}>Brak nieznanych przelewów dla tego rozliczenia.</div>
              ) : relatedReview.map((item) => (
                <div key={item.id} style={{ border: "1px solid rgba(255,255,255,.08)", borderRadius: 16, padding: 14, display: "grid", gap: 6 }}>
                  <div><strong>Nieznany przelew</strong></div>
                  <div style={{ opacity: 0.78 }}>{item.title || item.description || item.type || item.id}</div>
                  <div style={{ opacity: 0.78 }}>Status: {item.status || "OPEN"}</div>
                  <div style={{ opacity: 0.78 }}>Kwota: {formatMoney(item.amountCents != null ? Number(item.amountCents) / 100 : item.amount)}</div>
                  <div>
                    <Link href="/review" className="btnGhost" style={{ display: "inline-flex", alignItems: "center", justifyContent: "center" }}>
                      Przypisz do lokalu
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        {transferOpen && settlement ? (
          <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.5)", display: "grid", placeItems: "center", padding: 20, zIndex: 1000 }} onClick={() => setTransferOpen(false)}>
            <div className="card" style={{ width: "100%", maxWidth: 520, display: "grid", gap: 16 }} onClick={(e) => e.stopPropagation()}>
              <div style={{ display: "flex", justifyContent: "space-between", gap: 12, alignItems: "center" }}>
                <h3 style={{ margin: 0 }}>Dane do przelewu</h3>
                <button className="btnGhost" onClick={() => setTransferOpen(false)}>Zamknij</button>
              </div>
              <div style={{ display: "grid", gap: 12 }}>
                <div>
                  <div style={{ opacity: 0.72, marginBottom: 4 }}>Numer konta</div>
                  <strong>{bankAccount}</strong>
                </div>
                <div>
                  <div style={{ opacity: 0.72, marginBottom: 4 }}>Kwota</div>
                  <strong>{formatMoney(total)}</strong>
                </div>
                <div>
                  <div style={{ opacity: 0.72, marginBottom: 4 }}>Tytuł</div>
                  <strong>{transferTitle}</strong>
                </div>
              </div>
              <div>
                <button className="btn" onClick={async () => {
                  const text = `Numer konta: ${bankAccount}\nKwota: ${formatMoney(total)}\nTytuł: ${transferTitle}`;
                  try {
                    await navigator.clipboard.writeText(text);
                    setMessage("Dane do przelewu skopiowane.");
                    setTransferOpen(false);
                  } catch {
                    setMessage("Nie udało się skopiować danych.");
                  }
                }}>Kopiuj</button>
              </div>
            </div>
          </div>
        ) : null}
      </div>
    </RequireAuth>
  );
}
