"use client";

import Link from "next/link";

export default function Tile({
  href,
  icon,
  title,
  desc,
}: {
  href: string;
  icon: React.ReactNode;
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
