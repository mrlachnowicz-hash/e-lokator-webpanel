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
    <div style={{ padding: 16, borderBottom: "1px solid #e5e5e5", display: "flex", gap: 12, alignItems: "center" }}>
      <Link href="/dashboard"><b>e-Lokator Webpanel</b></Link>
      <span style={{ opacity: 0.7 }}>({role || ""} / {comm || ""})</span>
      <div style={{ flex: 1 }} />
      <Link href="/import">Import</Link>
      <Link href="/buildings">Budynki</Link>
      <Link href="/flats">Lokale</Link>
      <Link href="/invoices">Faktury (KSeF)</Link>
      <Link href="/charges">Naliczenia</Link>
      <button onClick={() => signOut(auth)} style={{ marginLeft: 12 }}>Wyloguj</button>
    </div>
  );
}
