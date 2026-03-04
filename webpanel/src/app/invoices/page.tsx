"use client";

import { useEffect, useState } from "react";
import { collection, onSnapshot, orderBy, query, doc, updateDoc } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";
import { callable } from "../../lib/functions";

type Invoice = any;

export default function InvoicesPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [items, setItems] = useState<Invoice[]>([]);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!communityId) return;
    const q = query(collection(db, "communities", communityId, "ksefInvoices"), orderBy("createdAtMs", "desc"));
    return onSnapshot(q, (snap) => setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))));
  }, [communityId]);

  return (
    <RequireAuth roles={["MASTER", "ADMIN", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <h2>Faktury (KSeF) – MVP</h2>

        <div style={{ display: "flex", gap: 10 }}>
          <button
            onClick={async () => {
              setMsg(null);
              setErr(null);
              try {
                const fn = callable<any, any>("ksefFetchInvoices");
                const res = await fn({ communityId, count: 2 });
                setMsg(`Pobrano (MOCK): ${(res.data as any).created?.length || 0}`);
              } catch (e: any) {
                setErr(e?.message || "Błąd");
              }
            }}
          >
            Pobierz faktury (MOCK)
          </button>
        </div>
        {msg && <div style={{ color: "green" }}>{msg}</div>}
        {err && <div style={{ color: "crimson" }}>{err}</div>}

        <div style={{ display: "grid", gap: 10 }}>
          {items.map((inv) => (
            <InvoiceCard key={inv.id} communityId={communityId} inv={inv} />
          ))}
        </div>
      </div>
    </RequireAuth>
  );
}

function InvoiceCard({ communityId, inv }: { communityId: string; inv: Invoice }) {
  const [period, setPeriod] = useState(inv.assigned?.period || inv.parsed?.period || "");
  const [category, setCategory] = useState(inv.assigned?.category || inv.ai?.suggestion?.category || "INNE");
  const [scope, setScope] = useState(inv.assigned?.scope || inv.ai?.suggestion?.scope || "COMMON");
  const [buildingId, setBuildingId] = useState(inv.assigned?.buildingId || "");
  const [flatId, setFlatId] = useState(inv.assigned?.flatId || "");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const status = inv.status || "";
  const amount = inv.parsed?.totalGrossCents ? (inv.parsed.totalGrossCents / 100).toFixed(2) : "?";

  return (
    <div style={{ border: "1px solid #e5e5e5", borderRadius: 12, padding: 14, display: "grid", gap: 10 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <b>{inv.ksefNumber || inv.id}</b>
        <span style={{ opacity: 0.7 }}>status: {status}</span>
        <span style={{ opacity: 0.7 }}>kwota: {amount} PLN</span>
        <div style={{ flex: 1 }} />
        <button
          onClick={async () => {
            setMsg(null);
            setErr(null);
            try {
              const fn = callable<any, any>("ksefParseInvoice");
              await fn({ communityId, invoiceId: inv.id });
              setMsg("Parse OK");
            } catch (e: any) {
              setErr(e?.message || "Błąd");
            }
          }}
        >
          Parse
        </button>
        <button
          onClick={async () => {
            setMsg(null);
            setErr(null);
            try {
              const fn = callable<any, any>("aiSuggestInvoice");
              await fn({ communityId, invoiceId: inv.id });
              setMsg("AI sugestia OK");
            } catch (e: any) {
              setErr(e?.message || "Błąd");
            }
          }}
        >
          AI sugestia
        </button>
      </div>

      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(5, 1fr)" }}>
        <label style={{ display: "grid", gap: 4 }}>
          Okres (YYYY-MM)
          <input value={period} onChange={(e) => setPeriod(e.target.value)} />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          Kategoria
          <select value={category} onChange={(e) => setCategory(e.target.value)}>
            <option value="PRAD">PRAD</option>
            <option value="WODA">WODA</option>
            <option value="GAZ">GAZ</option>
            <option value="SPRZATANIE">SPRZATANIE</option>
            <option value="REMONT">REMONT</option>
            <option value="INNE">INNE</option>
          </select>
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          Zakres
          <select value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="COMMON">Części wspólne</option>
            <option value="FLAT">Konkretny lokal</option>
          </select>
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          buildingId (opcjonalnie)
          <input value={buildingId} onChange={(e) => setBuildingId(e.target.value)} />
        </label>
        <label style={{ display: "grid", gap: 4 }}>
          flatId (tylko dla FLAT)
          <input value={flatId} onChange={(e) => setFlatId(e.target.value)} />
        </label>
      </div>

      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <button
          onClick={async () => {
            setMsg(null);
            setErr(null);
            try {
              const fn = callable<any, any>("approveInvoice");
              const res = await fn({
                communityId,
                invoiceId: inv.id,
                assignment: { period, category, scope, buildingId: buildingId || null, flatId: flatId || null },
              });
              setMsg(`Zatwierdzono. Charges: ${(res.data as any).chargesCreated || 0}`);
            } catch (e: any) {
              setErr(e?.message || "Błąd");
            }
          }}
        >
          Zatwierdź + wygeneruj naliczenia
        </button>
        <button
          onClick={async () => {
            await updateDoc(doc(db, "communities", communityId, "ksefInvoices", inv.id), { status: "ODRZUCONA", rejectedAtMs: Date.now() });
          }}
        >
          Odrzuć
        </button>
        {msg && <div style={{ color: "green" }}>{msg}</div>}
        {err && <div style={{ color: "crimson" }}>{err}</div>}
      </div>

      {inv.ai?.suggestion && (
        <div style={{ opacity: 0.75 }}>
          <b>AI:</b> {JSON.stringify(inv.ai.suggestion)}
        </div>
      )}
    </div>
  );
}
