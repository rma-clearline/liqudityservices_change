"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const TABS = [
  { href: "/", label: "Listings" },
  { href: "/overview", label: "Overview" },
  { href: "/forecast", label: "Forecast" },
  { href: "/marketplace", label: "Marketplace" },
  { href: "/contracts", label: "Contracts" },
] as const;

export function Tabs() {
  const pathname = usePathname();
  return (
    <nav className="sticky top-0 z-30 -mx-6 mb-6 border-b bg-white/90 px-6 backdrop-blur">
      <div className="flex gap-1 overflow-x-auto">
        {TABS.map((t) => {
          const active = t.href === "/" ? pathname === "/" : pathname.startsWith(t.href);
          return (
            <Link
              key={t.href}
              href={t.href}
              aria-current={active ? "page" : undefined}
              className={`whitespace-nowrap border-b-2 px-4 py-2.5 text-sm font-medium transition-colors ${
                active
                  ? "border-gray-900 text-gray-900"
                  : "border-transparent text-gray-500 hover:text-gray-800"
              }`}
            >
              {t.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
