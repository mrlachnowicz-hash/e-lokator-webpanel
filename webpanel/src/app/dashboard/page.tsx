"use client";

import Link from "next/link";
import Tile from "../../components/Tile";
import { ISpreadsheet, IBuilding, IHome, IReceipt, ICoins, IShield, ILogout } from "./_icons";
import { useAuth } from "../../lib/authContext";

export default function DashboardPage() {
  const { user, role, logout, communityId } = useAuth();

  return (
    <>
      <div className="topBar">
        <div className="brand">
          <div className="brandBadge" />
          <div>
            e-Lokator Webpanel{" "}
            <span style={{ color: "var(--muted)", fontWeight: 500, fontSize: 12 }}>
              ({role || "—"} / {user?.uid?.slice(0, 6) || "—"})
            </span>
          </div>
        </div>

        <div className="navLinks">
          <Link href="/import">Import</Link>
          <Link href="/buildings">Budynki</Link>
          <Link href="/flats">Lokale</Link>
          <Link href="/invoices">Faktury (KSeF)</Link>
          <Link href="/charges">Naliczania</Link>
          <button className="pillBtn" onClick={logout} title="Wyloguj">
            <span style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
              <span style={{ width: 16, height: 16, display: "inline-flex" }}><ILogout /></span>
              Wyloguj
            </span>
          </button>
        </div>
      </div>

      <div className="sectionTitle">Panel</div>

      <div className="grid">
        <Tile
          href="/import"
          icon={<ISpreadsheet />}
          title="Import lokali"
          desc="CSV/XLSX → flats + payer (mail-only) + zajęcie seats."
        />
        <Tile
          href="/buildings"
          icon={<IBuilding />}
          title="Budynki"
          desc="Lista i edycja budynków we wspólnocie."
        />
        <Tile
          href="/flats"
          icon={<IHome />}
          title="Lokale"
          desc="Podgląd lokali, payerów, metraż, dane kontaktowe."
        />
        <Tile
          href="/invoices"
          icon={<IReceipt />}
          title="Faktury (KSeF)"
          desc="Statusy + ręczne przypisanie + sugestie AI."
        />
        <Tile
          href="/charges"
          icon={<ICoins />}
          title="Naliczania"
          desc="Charges per flatId, okresy, salda i historia."
        />
        <Tile
          href="/payments"
          icon={<IShield />}
          title="Płatności / SSO"
          desc="Ustaw URL płatności (WebView + token SSO)."
        />
      </div>

      {role === "MASTER" && communityId && (
        <p style={{ marginTop: 16, color: "var(--muted)", fontSize: 12 }}>
          Community: {communityId}
        </p>
      )}
    </>
  );
}
