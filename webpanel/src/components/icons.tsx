"use client";

import React from "react";

const Icon = ({ children }: { children: React.ReactNode }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
    {children}
  </svg>
);

export const IconSpreadsheet = () => (
  <Icon>
    <path d="M4 4h16v16H4z" />
    <path d="M8 4v16M16 4v16M4 9h16M4 15h16" />
  </Icon>
);

export const IconBuilding = () => (
  <Icon>
    <path d="M3 21h18" />
    <path d="M6 21V4h12v17" />
    <path d="M9 8h2M13 8h2M9 12h2M13 12h2M9 16h2M13 16h2" />
  </Icon>
);

export const IconHome = () => (
  <Icon>
    <path d="M3 11l9-7 9 7" />
    <path d="M5 10v11h14V10" />
    <path d="M9 21v-6h6v6" />
  </Icon>
);

export const IconReceipt = () => (
  <Icon>
    <path d="M6 2h12v20l-2-1-2 1-2-1-2 1-2-1-2 1z" />
    <path d="M8 7h8M8 11h8M8 15h6" />
  </Icon>
);

export const IconCoins = () => (
  <Icon>
    <ellipse cx="12" cy="6" rx="7" ry="3" />
    <path d="M5 6v6c0 1.7 3.1 3 7 3s7-1.3 7-3V6" />
    <path d="M5 12v6c0 1.7 3.1 3 7 3s7-1.3 7-3v-6" />
  </Icon>
);

export const IconShield = () => (
  <Icon>
    <path d="M12 2l8 4v6c0 5-3.4 9.4-8 10-4.6-.6-8-5-8-10V6z" />
    <path d="M9 12l2 2 4-5" />
  </Icon>
);

export const IconGauge = () => (
  <Icon>
    <path d="M5 16a7 7 0 1114 0" />
    <path d="M12 13l4-4" />
    <path d="M12 20v1" />
  </Icon>
);
