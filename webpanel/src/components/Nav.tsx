"use client";

import Link from "next/link";
import { signOut } from "firebase/auth";
import { auth } from "../lib/firebase";
import { useAuth } from "../lib/authContext";

export function Nav() {
  const { profile } = useAuth();
  const role = profile?.role || "";
  const comm = profile?.communityId || "";

  return (
    <div className="topBar">
      <div className="brand">
        <div className="brandBadge" />
        <Link href="/dashboard">e-Lokator Webpanel</Link>
        <span className="brandMeta">({role || "—"} / {comm ? comm.slice(0, 6) : "—"})</span>
      </div>

      <div className="navLinks">
        <Link href="/import">Import</Link>
        <Link href="/buildings">Budynki</Link>
        <Link href="/flats">Lokale</Link>
        <Link href="/invoices">Faktury (KSeF)</Link>
        <Link href="/charges">Naliczania</Link>
        <button className="btnGhost" onClick={() => signOut(auth)}>
          Wyloguj
        </button>
      </div>
    </div>
  );
}
