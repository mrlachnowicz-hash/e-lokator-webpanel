"use client";

import { Suspense } from "react";
import { useSearchParams } from "next/navigation";

function SSOContent() {
  const params = useSearchParams();
  const token = params.get("token");

  return (
    <div style={{ padding: 40 }}>
      <h1>SSO Login</h1>
      <p>Token: {token}</p>
    </div>
  );
}

export default function Page() {
  return (
    <Suspense fallback={<div>Ładowanie...</div>}>
      <SSOContent />
    </Suspense>
  );
}
