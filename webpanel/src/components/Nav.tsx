"use client";

import Link from "next/link";
import { signOut } from "firebase/auth";
import { auth } from "../lib/firebase";
import { useAuth } from "../lib/authContext";
import { isPanelEnabled } from "../lib/panelAccess";

export function Nav() {
  const { profile, community } = useAuth();
  const role = profile?.role || "";
  const comm = profile?.communityId || "";
  const panelEnabled = isPanelEnabled(community?.panelAccessEnabled);

  return (
    <div className="topBar">
      <div className="brand">
        <div className="brandBadge" />
        <Link href="/dashboard">e-Lokator Webpanel</Link>
        <span className="brandMeta">({role || "—"} / {comm ? comm.slice(0, 6) : "—"})</span>
        {!panelEnabled ? <span className="brandMeta">panel OFF</span> : null}
      </div>

      <div className="navLinks">
        <Link href="/dashboard">Panel</Link>
        {panelEnabled ? (
          <>
            <Link href="/import">Import lokali</Link>
            <Link href="/streets">Ulice</Link>
            <Link href="/buildings">Budynki</Link>
            <Link href="/flats">Lokale</Link>
            <Link href="/invoices">Faktury</Link>
            <Link href="/charges">Rozliczenia</Link>
            <Link href="/meters">Liczniki</Link>
            <Link href="/payments">Przelewy</Link>
            <Link href="/review">Review</Link>
          </>
        ) : null}
        <button className="btnGhost" onClick={() => signOut(auth)}>
          Wyloguj
        </button>
      </div>
    </div>
  );
}
