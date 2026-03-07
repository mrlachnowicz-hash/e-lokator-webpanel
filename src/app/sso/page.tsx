"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signInWithCustomToken } from "firebase/auth";
import { auth } from "../../lib/firebase";

function SsoInner() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token") || "";
  const [message, setMessage] = useState("Ładowanie...");

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        if (!token) throw new Error("Brak tokenu SSO.");
        const res = await fetch("/api/sso/consume", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (!res.ok) throw new Error(await res.text());
        const data = await res.json();
        await signInWithCustomToken(auth, data.customToken);
        if (!active) return;
        setMessage("Zalogowano. Przekierowanie...");
        router.replace(data.target || "/dashboard");
      } catch (e: any) {
        if (!active) return;
        setMessage(`Błąd SSO: ${e?.message || String(e)}`);
      }
    })();
    return () => { active = false; };
  }, [router, token]);

  return <div style={{ padding: 24 }}>{message}</div>;
}

export default function SsoPage() {
  return <Suspense fallback={<div style={{ padding: 24 }}>Ładowanie...</div>}><SsoInner /></Suspense>;
}
