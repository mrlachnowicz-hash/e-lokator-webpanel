"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import Link from "next/link";
import { auth } from "../../lib/firebase";
import { useAuth } from "../../lib/authContext";

export default function LoginPage() {
  const router = useRouter();
  const { user, profile, loading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (loading || !user) return;

    const role = String(profile?.role || "");
    if (["MASTER", "ADMIN", "ACCOUNTANT"].includes(role)) {
      router.replace("/dashboard");
      return;
    }

    if (role) {
      setErr("Ta rola nie ma dostępu do webpanelu. Lokator korzysta z aplikacji mobilnej.");
      signOut(auth);
    }
  }, [loading, user, profile, router]);

  return (
    <div style={{ padding: 32, maxWidth: 420, margin: "0 auto" }}>
      <h2>Logowanie</h2>
      <p style={{ opacity: 0.7 }}>MASTER / ADMIN / ACCOUNTANT</p>
      <div style={{ display: "grid", gap: 10 }}>
        <input className="input" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <input className="input" placeholder="Hasło" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <button
          className="btn"
          onClick={async () => {
            setErr(null);
            try {
              await signInWithEmailAndPassword(auth, email, password);
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
