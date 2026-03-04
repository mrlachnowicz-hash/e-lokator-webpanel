"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { signInWithCustomToken } from "firebase/auth";
import { auth } from "../../lib/firebase";

export default function SsoPage() {
  const params = useSearchParams();
  const router = useRouter();
  const token = params.get("token") || "";
  const [status, setStatus] = useState("Ładowanie…");

  useEffect(() => {
    (async () => {
      if (!token) {
        setStatus("Brak token");
        return;
      }
      try {
        setStatus("Weryfikacja sesji…");
        const res = await fetch("/api/sso/consume", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ token }),
        });
        if (!res.ok) throw new Error(await res.text());
        const json = await res.json();
        setStatus("Logowanie…");
        await signInWithCustomToken(auth, json.customToken);
        router.replace(json.target || "/payments");
      } catch (e: any) {
        setStatus(e?.message || "Błąd SSO");
      }
    })();
  }, [token, router]);

  return <div style={{ padding: 24 }}>{status}</div>;
}
