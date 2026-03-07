"use client";

import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import { signOut } from "firebase/auth";
import { useAuth } from "../lib/authContext";
import { isPanelEnabled } from "../lib/panelAccess";
import { auth } from "../lib/firebase";

export function RequireAuth({ children, roles, requirePanelAccess = true }: { children: React.ReactNode; roles?: string[]; requirePanelAccess?: boolean }) {
  const { user, profile, community, loading } = useAuth();
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
        <div style={{ padding: 24, display: "grid", gap: 12, maxWidth: 560 }}>
          <h2 style={{ margin: 0 }}>Brak uprawnień</h2>
          <p style={{ margin: 0, opacity: 0.8 }}>
            Ta część webpanelu jest dostępna tylko dla ról administracyjnych. Aktualna rola: {role || "?"}.
          </p>
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
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
      );
    }
  }

  const panelEnabled = isPanelEnabled(community?.panelAccessEnabled);

  if (requirePanelAccess && !panelEnabled) {
    return (
      <div style={{ padding: 24, display: "grid", gap: 12, maxWidth: 640 }}>
        <h2 style={{ margin: 0 }}>Panel nie jest aktywny</h2>
        <p style={{ margin: 0, opacity: 0.8 }}>
          Panel rozliczeniowy nie został aktywowany dla tej wspólnoty. Włącz przełącznik <b>„Udziel dostępu do panelu”</b> w generatorze ownera,
          aby odblokować moduły księgowe i rozliczeniowe.
        </p>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <button className="btn" onClick={() => router.replace("/dashboard")}>Przejdź do panelu głównego</button>
          <button
            className="btnGhost"
            onClick={async () => {
              await signOut(auth);
              router.replace("/login");
            }}
          >
            Wyloguj
          </button>
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
