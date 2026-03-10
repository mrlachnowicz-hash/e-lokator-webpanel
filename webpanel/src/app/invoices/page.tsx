"use client";

import Link from "next/link";
import Nav from "@/components/Nav";
import RequireAuth from "@/components/RequireAuth";

export default function InvoicesPage() {
  return (
    <RequireAuth>
      <Nav />

      <div className="max-w-6xl mx-auto px-6 py-8 text-white">
        <div className="flex items-center justify-between mb-6">
          <h1 className="text-2xl font-semibold">Faktury</h1>

          <Link
            href="/invoices/archive"
            className="px-4 py-2 rounded-xl border border-white/20 hover:bg-white/10"
          >
            Archiwum faktur
          </Link>
        </div>

        <div className="rounded-xl border border-white/10 p-6">
          <p className="text-white/70">
            Tutaj pojawiają się nowe faktury oczekujące na przeniesienie do szkicu.
          </p>
        </div>
      </div>
    </RequireAuth>
  );
}
