"use client";

import Link from "next/link";
import { signOut } from "firebase/auth";
import { useRouter } from "next/navigation";
import { auth } from "../lib/firebase";
import { useAuth } from "../lib/authContext";

export function Nav() {
  const router = useRouter();
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
        <Link href="/dashboard">Panel</Link>
        <Link href="/import">Import lokali</Link>
        <Link href="/buildings">Budynki</Link>
        <Link href="/flats">Lokale</Link>
        <Link href="/invoices">Faktury</Link>
        <Link href="/charges">Naliczania</Link>
        <Link href="/payments">Przelewy</Link>
        <Link href="/review">Review</Link>
        <button
          className="btnGhost"
          onClick={async () => {
            await signOut(auth);
            router.replace("/login");
          }}
        >
          Wyloguj
        </button>
      </div>
    </div>
  );
}
