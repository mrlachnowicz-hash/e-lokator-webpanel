"use client";

import { useEffect, useState } from "react";
import { addDoc, collection, onSnapshot, orderBy, query } from "firebase/firestore";
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
  const [form, setForm] = useState({ vendorName: "", title: "", period: new Date().toISOString().slice(0, 7), totalGross: "", category: "INNE" });

  useEffect(() => {
    if (!communityId) return;
    const q = query(collection(db, "communities", communityId, "invoices"), orderBy("createdAtMs", "desc"));
    return onSnapshot(q, (snap) => setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }))));
  }, [communityId]);

  return (
    <RequireAuth roles={["MASTER", "ADMIN", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16 }}>
        <h2>Faktury</h2>
        <div className="card" style={{ display: "grid", gap: 12 }}>
          <h3>Dodaj ręcznie</h3>
          <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(5, 1fr)" }}>
            <input className="input" placeholder="Dostawca" value={form.vendorName} onChange={(e) => setForm({ ...form, vendorName: e.target.value })} />
            <input className="input" placeholder="Tytuł" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
            <input className="input" placeholder="YYYY-MM" value={form.period} onChange={(e) => setForm({ ...form, period: e.target.value })} />
            <input className="input" placeholder="Kwota brutto" value={form.totalGross} onChange={(e) => setForm({ ...form, totalGross: e.target.value })} />
            <select className="select" value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              <option value="PRAD">PRĄD</option>
              <option value="WODA">WODA</option>
              <option value="GAZ">GAZ</option>
              <option value="SPRZATANIE">SPRZĄTANIE</option>
              <option value="REMONT">REMONT</option>
              <option value="INNE">INNE</option>
            </select>
          </div>
          <div className="formRow">
            <button className="btn" onClick={async () => {
              await addDoc(collection(db, "communities", communityId, "invoices"), {
                vendorName: form.vendorName,
                title: form.title,
                period: form.period,
                category: form.category,
                totalGrossCents: Math.round(Number(form.totalGross.replace(",", ".")) * 100),
                currency: "PLN",
                status: "NOWA",
                source: "MANUAL",
                createdAtMs: Date.now(),
                updatedAtMs: Date.now(),
              });
              setForm({ ...form, vendorName: "", title: "", totalGross: "" });
            }}>Dodaj fakturę</button>
            <button className="btnGhost" onClick={async () => { await callable("ksefFetchInvoices")({ communityId, period: form.period }); }}>Pobierz mock KSeF</button>
          </div>
        </div>

        <div style={{ display: "grid", gap: 12 }}>
          {items.map((inv) => <InvoiceCard key={inv.id} inv={inv} communityId={communityId} />)}
        </div>
      </div>
    </RequireAuth>
  );
}

function InvoiceCard({ inv, communityId }: { inv: Invoice; communityId: string }) {
  const [period, setPeriod] = useState(inv.parsed?.period || inv.period || new Date().toISOString().slice(0, 7));
  const [category, setCategory] = useState(inv.parsed?.category || inv.category || "INNE");
  const [scope, setScope] = useState(inv.parsed?.scope || "COMMON");
  const [buildingId, setBuildingId] = useState(inv.parsed?.buildingId || "");
  const [flatId, setFlatId] = useState(inv.parsed?.flatId || "");
  const amount = Number(inv.parsed?.amountCents || inv.totalGrossCents || 0);

  return (
    <div className="card" style={{ display: "grid", gap: 10 }}>
      <div className="formRow">
        <strong>{inv.vendorName || "Faktura"}</strong>
        <span>{inv.title || inv.id}</span>
        <span>status: {inv.status}</span>
        <span>{(amount / 100).toFixed(2)} PLN</span>
      </div>
      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(5, 1fr)" }}>
        <input className="input" value={period} onChange={(e) => setPeriod(e.target.value)} />
        <select className="select" value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="PRAD">PRĄD</option>
          <option value="WODA">WODA</option>
          <option value="GAZ">GAZ</option>
          <option value="SPRZATANIE">SPRZĄTANIE</option>
          <option value="REMONT">REMONT</option>
          <option value="INNE">INNE</option>
        </select>
        <select className="select" value={scope} onChange={(e) => setScope(e.target.value)}>
          <option value="COMMON">Części wspólne</option>
          <option value="FLAT">Konkretny lokal</option>
        </select>
        <input className="input" placeholder="buildingId" value={buildingId} onChange={(e) => setBuildingId(e.target.value)} />
        <input className="input" placeholder="flatId" value={flatId} onChange={(e) => setFlatId(e.target.value)} />
      </div>
      <div className="formRow">
        <button className="btnGhost" onClick={async () => { await callable("ksefParseInvoice")({ communityId, invoiceId: inv.id }); }}>Parse</button>
        <button className="btnGhost" onClick={async () => { await callable("aiSuggestInvoice")({ communityId, invoiceId: inv.id }); }}>AI sugestia</button>
        <button className="btn" onClick={async () => { await callable("approveInvoice")({ communityId, invoiceId: inv.id, assignment: { period, category, scope, buildingId: buildingId || null, flatId: flatId || null } }); }}>Zatwierdź i nalicz</button>
      </div>
      {inv.ai?.suggestion ? <pre style={{ whiteSpace: "pre-wrap", margin: 0 }}>{JSON.stringify(inv.ai.suggestion, null, 2)}</pre> : null}
    </div>
  );
}
