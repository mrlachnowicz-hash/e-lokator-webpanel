import type { Metadata } from "next";
import React from "react";
import { AuthProvider } from "../lib/authContext";

export const metadata: Metadata = {
  title: "e-Lokator Webpanel",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pl">
      <body style={{ margin: 0, fontFamily: "system-ui, -apple-system, Segoe UI, Roboto, Arial" }}>
        <AuthProvider>{children}</AuthProvider>
      </body>
    </html>
  );
}
