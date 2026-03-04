"use client";

import React, { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "../lib/authContext";

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
      return <div className="loading">Brak uprawnień (rola: {role || "?"}).</div>;
    }
  }

  return <>{children}</>;
}
