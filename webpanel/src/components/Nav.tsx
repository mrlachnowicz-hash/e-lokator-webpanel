"use client";

import Link from "next/link";
import { useEffect } from "react";
import { signOut } from "firebase/auth";
import { auth } from "../lib/firebase";
import { useAuth } from "../lib/authContext";
import { isPanelEnabled } from "../lib/panelAccess";

export function Nav() {
  const { profile, community } = useAuth();
  const role = profile?.role || "";
  const comm = profile?.communityId || "";
  const panelEnabled = isPanelEnabled(community?.panelAccessEnabled);

  useEffect(() => {
    const run = async () => {
      try {
        if (!auth.currentUser || !comm || !panelEnabled) return;
        const key = `repair_sync_${comm}`;
        const prev = Number(window.localStorage.getItem(key) || 0);
        if (Date.now() - prev < 5 * 60 * 1000) return;
        window.localStorage.setItem(key, String(Date.now()));
        const token = await auth.currentUser.getIdToken();
        await fetch("/api/community-repair-sync", {
          method: "POST",
          headers: { "Content-Type": "application/json", authorization: `Bearer ${token}` },
          body: JSON.stringify({ communityId: comm }),
        }).catch(() => null);
      } catch (_) {}
    };
    run();
  }, [comm, panelEnabled]);

  return (
    <div className="topBar">
      <div className="brand">
        <div className="brandBadge" />
        <Link href="/dashboard">e-Lokator Webpanel</Link>
        <span className="brandMeta">({role || "—"} / {comm ? comm.slice(0, 6) : "—"})</span>
        {!panelEnabled ? <span className="brandMeta">panel wyłączony</span> : null}
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
            <Link href="/ksef">Ustaw KSeF</Link>
            <Link href="/charges">Rozliczenia</Link>
            <Link href="/meters">Liczniki</Link>
            <Link href="/payments">Przelewy</Link>
            <Link href="/review">Przegląd</Link>
          </>
        ) : null}
        <button className="btnGhost" onClick={() => signOut(auth)}>
          Wyloguj
        </button>
      </div>
    </div>
  );
}

export default Nav;
