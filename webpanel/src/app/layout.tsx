import type { Metadata } from "next";
import React from "react";
import "./globals.css";
import { AuthProvider } from "../lib/authContext";

export const metadata: Metadata = {
  title: "e-Lokator Webpanel",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pl">
      <body>
        <AuthProvider>
          <div className="container">{children}</div>
        </AuthProvider>
      </body>
    </html>
  );
}
