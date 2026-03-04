"use client";

import Link from "next/link";
import type { ReactNode } from "react";

export function Tile({
  href,
  icon,
  title,
  desc,
}: {
  href: string;
  icon: ReactNode;
  title: string;
  desc: string;
}) {
  return (
    <Link className="tile" href={href}>
      <div className="tileIcon">{icon}</div>
      <div className="tileTitle">{title}</div>
      <div className="tileDesc">{desc}</div>
    </Link>
  );
}
