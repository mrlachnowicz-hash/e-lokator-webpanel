"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createUserWithEmailAndPassword } from "firebase/auth";
import { auth } from "../../lib/firebase";
import { callable } from "../../lib/functions";

export default function RegisterPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [err, setErr] = useState<string | null>(null);

  return (
    <div style={{ padding: 32, maxWidth: 520, margin: "0 auto" }}>
      <h2>Rejestracja księgowej</h2>
      <p style={{ opacity: 0.7 }}>
        Podaj email/hasło i <b>kod wspólnoty</b> (join code) wygenerowany przez MASTER/ADMIN.
      </p>
      <div style={{ display: "grid", gap: 10 }}>
        <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input placeholder="Hasło" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <input placeholder="Kod wspólnoty" value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} />
        <button
          onClick={async () => {
            setErr(null);
            try {
              await createUserWithEmailAndPassword(auth, email, password);
              const claim = callable<{ code: string }, any>("claimJoinCode");
              await claim({ code });
              router.replace("/dashboard");
            } catch (e: any) {
              setErr(e?.message || "Błąd");
            }
          }}
        >
          Utwórz konto
        </button>
        {err && <div style={{ color: "crimson" }}>{err}</div>}
      </div>
    </div>
  );
}
