"use client";

import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { useAuth } from "../lib/authContext";
import { auth } from "../lib/firebase";

export function RequireAuth({ children, roles }: { children: React.ReactNode; roles?: string[] }) {
  const { user, profile, loading } = useAuth();
  const router = useRouter();

  useEffect(() => {
    if (loading) return;
    if (!user) router.replace("/login");
  }, [loading, user, router]);

  if (loading) return <div className="loading">Ładowanie…</div>;
  if (!user) return null;

  if (roles && roles.length) {
    const role = String(profile?.role || "");
    if (!roles.includes(role)) {
      return (
        <div className="accessWrap">
          <div className="card accessCard">
            <h2>Brak uprawnień</h2>
            <p>Ta część systemu jest dostępna tylko dla administratorów webpanelu.</p>
            <p>Twoja rola: <strong>{role || "?"}</strong></p>
            <div className="formRow">
              <button
                className="btn"
                onClick={async () => {
                  await signOut(auth);
                  router.replace("/login");
                }}
              >
                Wyloguj
              </button>
            </div>
          </div>
        </div>
      );
    }
  }

  return <>{children}</>;
}
