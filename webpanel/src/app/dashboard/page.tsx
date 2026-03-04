"use client";

import { Tile } from "@/components/Tile";
import Link from "next/link";
import {
  Building2,
  FileSpreadsheet,
  Home,
  Receipt,
  Coins,
  ShieldCheck,
  LogOut,
} from "lucide-react";
import { useAuth } from "@/lib/authContext";

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
              <LogOut size={16} /> Wyloguj
            </span>
          </button>
        </div>
      </div>

      <div className="sectionTitle">Panel</div>

      <div className="grid">
        <Tile
          href="/import"
          icon={<FileSpreadsheet />}
          title="Import lokali"
          desc="CSV/XLSX → flats + payer (mail-only) + zajęcie seats."
        />
        <Tile
          href="/buildings"
          icon={<Building2 />}
          title="Budynki"
          desc="Lista i edycja budynków we wspólnocie."
        />
        <Tile
          href="/flats"
          icon={<Home />}
          title="Lokale"
          desc="Podgląd lokali, payerów, metraż, dane kontaktowe."
        />
        <Tile
          href="/invoices"
          icon={<Receipt />}
          title="Faktury (KSeF)"
          desc="NOWA/DO_PRZYPISANIA/ZATWIERDZONA/ODRZUCONA + ręczne przypisanie."
        />
        <Tile
          href="/charges"
          icon={<Coins />}
          title="Naliczania"
          desc="Charges per flatId, okresy, salda i historia."
        />
        <Tile
          href="/payments"
          icon={<ShieldCheck />}
          title="Płatności / SSO"
          desc="Ustaw URL panelu płatności dla aplikacji (WebView + token)."
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
