"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { signInWithEmailAndPassword } from "firebase/auth";
import Link from "next/link";
import { auth } from "../../lib/firebase";

export default function LoginPage() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);

  return (
    <div style={{ padding: 32, maxWidth: 420, margin: "0 auto" }}>
      <h2>Logowanie</h2>
      <p style={{ opacity: 0.7 }}>MASTER / ADMIN / ACCOUNTANT</p>
      <div style={{ display: "grid", gap: 10 }}>
        <input placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input placeholder="Hasło" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button
          onClick={async () => {
            setErr(null);
            try {
              await signInWithEmailAndPassword(auth, email, password);
              router.replace("/dashboard");
            } catch (e: any) {
              setErr(e?.message || "Błąd");
            }
          }}
        >
          Zaloguj
        </button>
        {err && <div style={{ color: "crimson" }}>{err}</div>}
        <div style={{ marginTop: 12 }}>
          <Link href="/register">Rejestracja księgowej (kod wspólnoty)</Link>
        </div>
      </div>
    </div>
  );
}
