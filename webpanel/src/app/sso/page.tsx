"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signInWithCustomToken } from "firebase/auth";
import { auth } from "../../lib/firebase";

function SsoInner() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token") || "";
  const [status, setStatus] = useState<"INIT" | "OK" | "ERR">("INIT");
  const [message, setMessage] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        if (!token) {
          setStatus("ERR");
          setMessage("Brak tokenu SSO.");
          return;
        }
        await signInWithCustomToken(auth, token);
        if (cancelled) return;
        setStatus("OK");
        setMessage("Zalogowano. Przekierowanie…");
        router.replace("/payments");
      } catch (e: any) {
        if (cancelled) return;
        setStatus("ERR");
        setMessage(e?.message ?? String(e));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, router]);

  return (
    <div style={{ padding: 24 }}>
      <h2>SSO</h2>
      {status === "INIT" && <p>Ładowanie…</p>}
      {status === "OK" && <p>{message}</p>}
      {status === "ERR" && (
        <p style={{ color: "#ff6b6b" }}>
          Błąd SSO: {message || "Nieznany błąd"}
        </p>
      )}
    </div>
  );
}

export default function SsoPage() {
  return (
    <Suspense fallback={<div style={{ padding: 24 }}>Ładowanie…</div>}>
      <SsoInner />
    </Suspense>
  );
}
