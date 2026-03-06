"use client";

import { useEffect, useState } from "react";
import { addDoc, collection, onSnapshot, orderBy, query } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";
import { callable } from "../../lib/functions";

type Invoice = any;

const formGridStyle: React.CSSProperties = {
  display: "grid",
  gap: 10,
  gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
  alignItems: "stretch",
  minWidth: 0,
};

const actionRowStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 10,
  alignItems: "center",
};

const cardHeaderStyle: React.CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 12,
  alignItems: "center",
  minWidth: 0,
};

const fieldStyle: React.CSSProperties = {
  width: "100%",
  minWidth: 0,
  boxSizing: "border-box",
};

export default function InvoicesPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const [items, setItems] = useState<Invoice[]>([]);
  const [form, setForm] = useState({
    vendorName: "",
    title: "",
    period: new Date().toISOString().slice(0, 7),
    totalGross: "",
    category: "INNE",
  });

  useEffect(() => {
    if (!communityId) return;
    const q = query(
      collection(db, "communities", communityId, "invoices"),
      orderBy("createdAtMs", "desc")
    );
    return onSnapshot(q, (snap) =>
      setItems(snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) })))
    );
  }, [communityId]);

  return (
    <RequireAuth roles={["MASTER", "ADMIN", "ACCOUNTANT"]}>
      <Nav />
      <div style={{ padding: 24, display: "grid", gap: 16, minWidth: 0 }}>
        <h2>Faktury</h2>

        <div className="card" style={{ display: "grid", gap: 12, minWidth: 0 }}>
          <h3>Dodaj ręcznie</h3>

          <div style={formGridStyle}>
            <input
              className="input"
              style={fieldStyle}
              placeholder="Dostawca"
              value={form.vendorName}
              onChange={(e) => setForm({ ...form, vendorName: e.target.value })}
            />
            <input
              className="input"
              style={fieldStyle}
              placeholder="Tytuł"
              value={form.title}
              onChange={(e) => setForm({ ...form, title: e.target.value })}
            />
            <input
              className="input"
              style={fieldStyle}
              placeholder="YYYY-MM"
              value={form.period}
              onChange={(e) => setForm({ ...form, period: e.target.value })}
            />
            <input
              className="input"
              style={fieldStyle}
              placeholder="Kwota brutto"
              value={form.totalGross}
              onChange={(e) => setForm({ ...form, totalGross: e.target.value })}
            />
            <select
              className="select"
              style={fieldStyle}
              value={form.category}
              onChange={(e) => setForm({ ...form, category: e.target.value })}
            >
              <option value="PRAD">PRĄD</option>
              <option value="WODA">WODA</option>
              <option value="GAZ">GAZ</option>
              <option value="SPRZATANIE">SPRZĄTANIE</option>
              <option value="REMONT">REMONT</option>
              <option value="INNE">INNE</option>
            </select>
          </div>

          <div style={actionRowStyle}>
            <button
              className="btn"
              onClick={async () => {
                await addDoc(collection(db, "communities", communityId, "invoices"), {
                  vendorName: form.vendorName,
                  title: form.title,
                  period: form.period,
                  category: form.category,
                  totalGrossCents: Math.round(
                    Number((form.totalGross || "0").replace(",", ".")) * 100
                  ),
                  currency: "PLN",
                  status: "NOWA",
                  source: "MANUAL",
                  createdAtMs: Date.now(),
                  updatedAtMs: Date.now(),
                });
                setForm({
                  ...form,
                  vendorName: "",
                  title: "",
                  totalGross: "",
                });
              }}
            >
              Dodaj fakturę
            </button>

            <button
              className="btnGhost"
              onClick={async () => {
                await callable("ksefFetchInvoices")({
                  communityId,
                  period: form.period,
                });
              }}
            >
              Pobierz mock KSeF
            </button>
          </div>
        </div>

        <div style={{ display: "grid", gap: 12, minWidth: 0 }}>
          {items.map((inv) => (
            <InvoiceCard key={inv.id} inv={inv} communityId={communityId} />
          ))}
        </div>
      </div>
    </RequireAuth>
  );
}

function InvoiceCard({ inv, communityId }: { inv: Invoice; communityId: string }) {
  const [period, setPeriod] = useState(
    inv.parsed?.period || inv.period || new Date().toISOString().slice(0, 7)
  );
  const [category, setCategory] = useState(inv.parsed?.category || inv.category || "INNE");
  const [scope, setScope] = useState(inv.parsed?.scope || "COMMON");
  const [buildingId, setBuildingId] = useState(inv.parsed?.buildingId || "");
  const [flatId, setFlatId] = useState(inv.parsed?.flatId || "");
  const amount = Number(inv.parsed?.amountCents || inv.totalGrossCents || 0);

  const showBuildingId = true;
  const showFlatId = scope === "FLAT";

  return (
    <div className="card" style={{ display: "grid", gap: 10, minWidth: 0 }}>
      <div style={cardHeaderStyle}>
        <strong>{inv.vendorName || "Faktura"}</strong>
        <span>{inv.title || inv.id}</span>
        <span>status: {inv.status}</span>
        <span>{(amount / 100).toFixed(2)} PLN</span>
      </div>

      <div style={formGridStyle}>
        <input
          className="input"
          style={fieldStyle}
          value={period}
          onChange={(e) => setPeriod(e.target.value)}
          placeholder="YYYY-MM"
        />

        <select
          className="select"
          style={fieldStyle}
          value={category}
          onChange={(e) => setCategory(e.target.value)}
        >
          <option value="PRAD">PRĄD</option>
          <option value="WODA">WODA</option>
          <option value="GAZ">GAZ</option>
          <option value="SPRZATANIE">SPRZĄTANIE</option>
          <option value="REMONT">REMONT</option>
          <option value="INNE">INNE</option>
        </select>

        <select
          className="select"
          style={fieldStyle}
          value={scope}
          onChange={(e) => setScope(e.target.value)}
        >
          <option value="COMMON">Części wspólne</option>
          <option value="FLAT">Konkretny lokal</option>
        </select>

        {showBuildingId ? (
          <input
            className="input"
            style={fieldStyle}
            placeholder="buildingId"
            value={buildingId}
            onChange={(e) => setBuildingId(e.target.value)}
          />
        ) : null}

        {showFlatId ? (
          <input
            className="input"
            style={fieldStyle}
            placeholder="flatId"
            value={flatId}
            onChange={(e) => setFlatId(e.target.value)}
          />
        ) : null}
      </div>

      <div style={actionRowStyle}>
        <button
          className="btnGhost"
          onClick={async () => {
            await callable("ksefParseInvoice")({ communityId, invoiceId: inv.id });
          }}
        >
          Parse
        </button>

        <button
          className="btnGhost"
          onClick={async () => {
            await callable("aiSuggestInvoice")({ communityId, invoiceId: inv.id });
          }}
        >
          AI sugestia
        </button>

        <button
          className="btn"
          onClick={async () => {
            await callable("approveInvoice")({
              communityId,
              invoiceId: inv.id,
              assignment: {
                period,
                category,
                scope,
                buildingId: buildingId || null,
                flatId: showFlatId ? flatId || null : null,
              },
            });
          }}
        >
          Zatwierdź i nalicz
        </button>
      </div>

      {inv.ai?.suggestion ? (
        <pre
          style={{
            whiteSpace: "pre-wrap",
            overflowX: "auto",
            margin: 0,
          }}
        >
          {JSON.stringify(inv.ai.suggestion, null, 2)}
        </pre>
      ) : null}
    </div>
  );
}
