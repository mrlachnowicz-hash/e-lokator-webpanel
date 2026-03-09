"use client";

import Link from "next/link";

export { default } from "../page";

export function ArchiveShortcut() {
  return (
    <div className="mb-4">
      <Link href="/invoices/archive" className="px-4 py-2 rounded-xl border border-white/20 text-white inline-flex">
        Przejdź do archiwum faktur
      </Link>
    </div>
  );
}
