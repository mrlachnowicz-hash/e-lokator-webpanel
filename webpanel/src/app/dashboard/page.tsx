"use client";

import { useEffect, useMemo, useState } from "react";
import { collection, doc, getCountFromServer, getDoc, setDoc } from "firebase/firestore";
import { RequireAuth } from "../../components/RequireAuth";
import { Nav } from "../../components/Nav";
import { useAuth } from "../../lib/authContext";
import { db } from "../../lib/firebase";
import { callable } from "../../lib/functions";
import { Tile } from "../../components/Tile";
import { IconSpreadsheet, IconBuilding, IconHome, IconReceipt, IconCoins, IconShield } from "../../components/icons";

export default function DashboardPage() {
  const { profile, community } = useAuth();
  const communityId = profile?.communityId || "";
  const role = String(profile?.role || "");
  const panelEnabled = community?.panelAccessEnabled === true;
  const [webpanelUrl, setWebpanelUrl] = useState("");
  const [joinCode, setJoinCode] = useState("");
  const [stats, setStats] = useState({ flats: 0, invoices: 0, settlements: 0, review: 0, unmatchedPayments: 0 });

  useEffect(() => {
    if (!communityId) return;
    (async () => {
      const communitySnap = await getDoc(doc(db, "communities", communityId));
      setWebpanelUrl(String(communitySnap.data()?.webpanelUrl || communitySnap.data()?.paymentsUrl || ""));
      if (!panelEnabled) {
        setStats({ flats: 0, invoices: 0, settlements: 0, review: 0, unmatchedPayments: 0 });
        return;
      }
      const [flats, invoices, settlements, review] = await Promise.all([
        getCountFromServer(collection(db, "communities", communityId, "flats")),
        getCountFromServer(collection(db, "communities", communityId, "invoices")),
        getCountFromServer(collection(db, "communities", communityId, "settlements")),
        getCountFromServer(collection(db, "communities", communityId, "reviewQueue")),
      ]);
      setStats({
        flats: Number(flats.data().count || 0),
        invoices: Number(invoices.data().count || 0),
        settlements: Number(settlements.data().count || 0),
        review: Number(review.data().count || 0),
        unmatchedPayments: 0,
      });
    })();
  }, [communityId, panelEnabled]);

  const saveWebpanelUrl = async () => {
    if (!communityId) return;
    await setDoc(doc(db, "communities", communityId), { webpanelUrl, updatedAtMs: Date.now() }, { merge: true });
    alert("Zapisano adres webpanelu / SSO.");
  };

  const genJoinCode = async () => {
    if (!communityId) return;
    const res = await callable("createJoinCode")({ communityId, role: "ACCOUNTANT" });
    setJoinCode(String((res as any)?.data?.code || ""));
  };

  const cards = useMemo(() => [
    { href: "/import", icon: <IconSpreadsheet />, title: "Import lokali", desc: "CSV/XLSX → flats + payers" },
    { href: "/buildings", icon: <IconBuilding />, title: "Budynki", desc: "Budynki utworzone przez aplikację" },
    { href: "/flats", icon: <IconHome />, title: "Lokale", desc: "Lokal jako jednostka rozliczeniowa" },
    { href: "/invoices", icon: <IconReceipt />, title: "Faktury", desc: "Import, parse, review, approve" },
    { href: "/charges", icon: <IconCoins />, title: "Rozliczenia", desc: "Charges, settlements, balances" },
    { href: "/payments", icon: <IconShield />, title: "Przelewy", desc: "Import CSV/XLSX i dopasowanie po EL-xxx" },
  ], []);

  return (
    <RequireAuth roles={["MASTER", "ADMIN", "ACCOUNTANT"]} requirePanelAccess={false}>
      <Nav />
      <div className="sectionTitle">Panel rozliczeń</div>

      {!panelEnabled ? (
        <div className="card" style={{ maxWidth: 960 }}>
          <h3>Panel nieaktywny dla tej wspólnoty</h3>
          <p>
            Przełącznik <b>„Udziel dostępu do panelu”</b> jest obecnie ustawiony na OFF. Aplikacja mobilna i generator działają dalej normalnie,
            ale moduły księgowe i rozliczeniowe webpanelu pozostają zablokowane.
          </p>
        </div>
      ) : (
        <>
          <div className="grid">{cards.map((x) => <Tile key={x.href} {...x} />)}</div>

          <div className="sectionTitle">Statystyki</div>
          <div className="grid">
            <div className="card"><h3>Lokale</h3><p>{stats.flats}</p></div>
            <div className="card"><h3>Faktury</h3><p>{stats.invoices}</p></div>
            <div className="card"><h3>Rozliczenia</h3><p>{stats.settlements}</p></div>
            <div className="card"><h3>Review queue</h3><p>{stats.review}</p></div>
          </div>
        </>
      )}

      <div className="sectionTitle">Konfiguracja</div>
      <div style={{ display: "grid", gap: 16, maxWidth: 960 }}>
        <div className="card">
          <h3>Adres webpanelu / SSO</h3>
          <p>Aplikacja może otwierać webpanel przez <code>createWebSession</code> i ekran <code>/sso?token=...</code>.</p>
          <div className="formRow">
            <input className="input" value={webpanelUrl} onChange={(e) => setWebpanelUrl(e.target.value)} placeholder="https://twoj-panel.vercel.app" />
            <button className="btn" onClick={saveWebpanelUrl} disabled={!communityId}>Zapisz</button>
          </div>
        </div>
        {(role === "MASTER" || role === "ADMIN") && panelEnabled && (
          <div className="card">
            <h3>Kod dla księgowej</h3>
            <p>Jednorazowy kod rejestracyjny do podpięcia roli ACCOUNTANT do tej wspólnoty.</p>
            <div className="formRow">
              <button className="btn" onClick={genJoinCode} disabled={!communityId}>Generuj kod</button>
              {joinCode ? <strong>{joinCode}</strong> : null}
            </div>
          </div>
        )}
      </div>
    </RequireAuth>
  );
}
