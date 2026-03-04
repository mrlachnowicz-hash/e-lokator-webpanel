"use client";

import { useState } from "react";
import { doc, setDoc } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";
import { callable } from "../../lib/functions";
import { Tile } from "../../components/Tile";
import { IconSpreadsheet, IconBuilding, IconHome, IconReceipt, IconCoins, IconShield } from "../../components/icons";

export default function DashboardPage() {
  const { profile } = useAuth();
  const communityId = profile?.communityId || "";
  const role = String(profile?.role || "");

  const [paymentsUrl, setPaymentsUrl] = useState("");
  const [ksefMode, setKsefMode] = useState<"MOCK" | "REAL">("MOCK");
  const [ksefId, setKsefId] = useState("");
  const [joinCode, setJoinCode] = useState<string>("");

  const savePaymentsUrl = async () => {
    if (!communityId) return;
    await setDoc(
      doc(db, "communities", communityId),
      { paymentsUrl },
      { merge: true }
    );
    alert("Zapisano paymentsUrl.");
  };

  const genJoinCode = async () => {
    if (!communityId) return;
    const res = await callable("createJoinCode")({ communityId, role: "ACCOUNTANT" });
    setJoinCode(String(res?.data?.code ?? ""));
  };

  const saveKsefCfg = async () => {
    if (!communityId) return;
    await setDoc(
      doc(db, "communities", communityId),
      { ksef: { mode: ksefMode, ident: ksefId } },
      { merge: true }
    );
    alert("Zapisano konfigurację KSeF.");
  };

  return (
    <RequireAuth roles={["MASTER", "ADMIN", "ACCOUNTANT"]}>
      <Nav />

      <div className="sectionTitle">Panel</div>

      <div className="grid">
        <Tile href="/import" icon={<IconSpreadsheet />} title="Import lokali" desc="CSV/XLSX → flats + payer (mail-only) + zajęcie seats." />
        <Tile href="/buildings" icon={<IconBuilding />} title="Budynki" desc="Lista i edycja budynków we wspólnocie." />
        <Tile href="/flats" icon={<IconHome />} title="Lokale" desc="Podgląd lokali, payerów, metraż, dane kontaktowe." />
        <Tile href="/invoices" icon={<IconReceipt />} title="Faktury (KSeF)" desc="Statusy + ręczne przypisanie + sugestie AI." />
        <Tile href="/charges" icon={<IconCoins />} title="Naliczania" desc="Charges per flatId, okresy, salda i historia." />
        <Tile href="/payments" icon={<IconShield />} title="Płatności / SSO" desc="Panel płatności (WebView + token SSO)." />
      </div>

      <div className="sectionTitle">Konfiguracja</div>

      <div style={{ display: "grid", gap: 16, maxWidth: 980 }}>
        <div className="card">
          <h3>SSO / Płatności</h3>
          <p>Aplikacja Android czyta <code>communities/{communityId || "..."}/paymentsUrl</code> i otwiera WebView.</p>
          <div className="formRow">
            <input className="input" placeholder="np. https://panel.e-lokator.org/sso" value={paymentsUrl} onChange={(e) => setPaymentsUrl(e.target.value)} />
            <button className="btn" onClick={savePaymentsUrl} disabled={!communityId}>Zapisz</button>
          </div>
          {!communityId && <p style={{ marginTop: 10, color: "var(--muted)" }}>Brak communityId w profilu – uzupełnij w Firestore users/{profile.uid}.</p>}
        </div>

        {(role === "MASTER" || role === "ADMIN") && (
          <div className="card">
            <h3>Kod rejestracji księgowej</h3>
            <p>Wygeneruj kod (join code) i przekaż księgowej. Księgowa rejestruje się w panelu.</p>
            <div className="formRow">
              <button className="btn" onClick={genJoinCode} disabled={!communityId}>Generuj kod</button>
              {joinCode && <span style={{ fontWeight: 900, letterSpacing: 1 }}>{joinCode}</span>}
            </div>
          </div>
        )}

        {(role === "MASTER" || role === "ADMIN" || role === "ACCOUNTANT") && (
          <div className="card">
            <h3>KSeF – konfiguracja (MVP)</h3>
            <p>Na MVP tryb MOCK generuje przykładowe faktury. Tryb REAL to TODO (tokeny KSeF).</p>
            <div className="formRow">
              <select className="select" value={ksefMode} onChange={(e) => setKsefMode(e.target.value as any)}>
                <option value="MOCK">MOCK</option>
                <option value="REAL">REAL (TODO)</option>
              </select>
              <input className="input" placeholder="Identyfikator (np. NIP wspólnoty)" value={ksefId} onChange={(e) => setKsefId(e.target.value)} />
              <button className="btn" onClick={saveKsefCfg} disabled={!communityId}>Zapisz</button>
            </div>
          </div>
        )}
      </div>
    </RequireAuth>
  );
}
