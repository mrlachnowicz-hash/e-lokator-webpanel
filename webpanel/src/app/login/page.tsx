"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { signInWithEmailAndPassword, signOut } from "firebase/auth";
import Link from "next/link";
import { auth } from "../../lib/firebase";
import { useAuth } from "../../lib/authContext";

const ALLOWED_ROLES = ["MASTER", "ADMIN", "ACCOUNTANT"];

export default function LoginPage() {
  const router = useRouter();
  const { user, profile, loading } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [checkingRole, setCheckingRole] = useState(false);

  useEffect(() => {
    if (loading || !user) return;
    const role = String(profile?.role || "");

    if (!role) {
      setCheckingRole(true);
      return;
    }

    if (ALLOWED_ROLES.includes(role)) {
      router.replace("/dashboard");
      return;
    }

    setCheckingRole(false);
    setErr("To konto nie ma dostępu do webpanelu. Lokator korzysta z aplikacji mobilnej.");
    signOut(auth).catch(() => undefined);
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
          disabled={checkingRole}
          onClick={async () => {
            setErr(null);
            setCheckingRole(false);
            try {
              await signInWithEmailAndPassword(auth, email, password);
              setCheckingRole(true);
            } catch (e: any) {
              setErr(e?.message || "Błąd");
            }
          }}
        >
          {checkingRole ? "Sprawdzanie roli..." : "Zaloguj"}
        </button>
        {err && <div style={{ color: "crimson" }}>{err}</div>}
        <div style={{ marginTop: 12 }}>
          <Link href="/register">Rejestracja księgowej (kod wspólnoty)</Link>
        </div>
      </div>
    </div>
  );
}
