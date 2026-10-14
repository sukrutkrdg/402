"use client";

import { useState, useEffect, useRef } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import ThemeToggle from "./ThemeToggle";

interface NavLinkItem {
  href: string;
  label: string;
  badge?: string;
  external?: boolean;
}

const PRIMARY_LINKS: NavLinkItem[] = [
  { href: "/", label: "Marketplace" },
  { href: "/app", label: "🛡️ Check Token" },
  { href: "/stocks", label: "📊 Stocks" },
  { href: "/near", label: "Ⓝ NEAR" },
  { href: "/swap", label: "🔁 Swap" },
  { href: "/credits", label: "🎟️ Prepaid Credits" },
];

const MORE_LINKS: NavLinkItem[] = [
  { href: "/scout", label: "🎯 Service Scout" },
  { href: "/agents", label: "🤖 For Agents & MCP" },
  { href: "/dashboard", label: "📈 Dashboard" },
  { href: "/playground", label: "🧪 Playground" },
  { href: "/stats", label: "📊 Onchain Stats" },
  { href: "/status", label: "🟢 System Status" },
  {
    href: "https://docs.cdp.coinbase.com/x402/core-concepts/builder-codes",
    label: "📖 Docs ↗",
    external: true,
  },
];

export default function HeaderNav() {
  const pathname = usePathname();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef<HTMLDivElement>(null);

  // Close menus on route change
  useEffect(() => {
    setMobileOpen(false);
    setMoreOpen(false);
  }, [pathname]);

  // Close 'More' dropdown on click outside
  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (moreRef.current && !moreRef.current.contains(event.target as Node)) {
        setMoreOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Prevent background scroll when mobile menu is open
  useEffect(() => {
    if (mobileOpen) {
      document.body.style.overflow = "hidden";
    } else {
      document.body.style.overflow = "";
    }
    return () => {
      document.body.style.overflow = "";
    };
  }, [mobileOpen]);

  const isActive = (href: string) => pathname === href;

  return (
    <div className="flex items-center gap-1.5 sm:gap-2">
      {/* Desktop Navigation (>= lg) */}
      <nav className="hidden lg:flex items-center gap-1 text-sm font-medium">
        {PRIMARY_LINKS.map((link) => {
          const active = isActive(link.href);
          return (
            <Link
              key={link.href}
              href={link.href}
              className={`rounded-lg px-2.5 py-1.5 transition text-xs xl:text-sm ${
                active
                  ? "bg-white/10 text-white font-semibold"
                  : "text-gray-300 hover:bg-white/5 hover:text-white"
              }`}
            >
              {link.label}
            </Link>
          );
        })}

        {/* Desktop 'More' Dropdown */}
        <div className="relative" ref={moreRef}>
          <button
            type="button"
            onClick={() => setMoreOpen(!moreOpen)}
            className={`flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs xl:text-sm transition cursor-pointer ${
              moreOpen
                ? "bg-white/10 text-white font-semibold"
                : "text-gray-300 hover:bg-white/5 hover:text-white"
            }`}
            aria-expanded={moreOpen}
            aria-haspopup="true"
          >
            <span>More</span>
            <span className={`text-[10px] transition-transform duration-200 ${moreOpen ? "rotate-180" : ""}`}>
              ▼
            </span>
          </button>

          {moreOpen && (
            <div className="absolute right-0 mt-1.5 w-64 rounded-xl border border-white/10 bg-[#0d1017] p-1.5 shadow-2xl backdrop-blur-xl z-50 animate-in fade-in slide-in-from-top-1 duration-150">
              {MORE_LINKS.map((item) =>
                item.external ? (
                  <a
                    key={item.href}
                    href={item.href}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center justify-between rounded-lg px-3 py-2 text-xs text-gray-300 hover:bg-white/10 hover:text-white transition"
                  >
                    <span>{item.label}</span>
                    {item.badge && (
                      <span className="text-[9px] font-bold text-amber-300 bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.2 rounded">
                        {item.badge}
                      </span>
                    )}
                  </a>
                ) : (
                  <Link
                    key={item.href}
                    href={item.href}
                    className={`flex items-center justify-between rounded-lg px-3 py-2 text-xs transition ${
                      isActive(item.href)
                        ? "bg-white/10 text-white font-semibold"
                        : "text-gray-300 hover:bg-white/10 hover:text-white"
                    }`}
                  >
                    <span className="truncate">{item.label}</span>
                    {item.badge && (
                      <span className="text-[9px] font-bold text-amber-300 bg-amber-500/15 border border-amber-500/30 px-1.5 py-0.2 rounded shrink-0 ml-1.5">
                        {item.badge}
                      </span>
                    )}
                  </Link>
                )
              )}
            </div>
          )}
        </div>
      </nav>

      {/* Social X Icon (Desktop) */}
      <a
        href="https://x.com/sukrutkrdg"
        target="_blank"
        rel="noreferrer"
        aria-label="x402 Bazaar on X"
        title="@sukrutkrdg on X"
        className="hidden sm:grid h-8 w-8 place-items-center rounded-lg text-gray-400 hover:bg-white/5 hover:text-white transition"
      >
        <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor" aria-hidden="true">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817-5.97 6.817H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
        </svg>
      </a>

      {/* Quick Access Check Token on Compact Screens (< lg) */}
      <Link
        href="/app"
        className="lg:hidden rounded-lg px-2.5 py-1 text-xs font-semibold text-sky-300 bg-sky-500/10 border border-sky-500/20 hover:bg-sky-500/20 transition whitespace-nowrap"
      >
        🛡️ Check
      </Link>

      {/* Theme Toggle Button */}
      <ThemeToggle />

      {/* Mobile Hamburger Button (< lg) */}
      <button
        type="button"
        onClick={() => setMobileOpen(!mobileOpen)}
        className="lg:hidden grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-white/5 text-gray-200 hover:bg-white/10 hover:text-white transition cursor-pointer"
        aria-label="Toggle navigation menu"
        aria-expanded={mobileOpen}
      >
        {mobileOpen ? (
          <span className="text-sm font-bold leading-none">✕</span>
        ) : (
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        )}
      </button>

      {/* Mobile Fullscreen Drawer / Overlay */}
      {mobileOpen && (
        <div className="fixed inset-0 top-[57px] z-50 lg:hidden">
          {/* Backdrop */}
          <div
            className="absolute inset-0 bg-black/70 backdrop-blur-md"
            onClick={() => setMobileOpen(false)}
          />

          {/* Menu Card */}
          <div className="relative mx-3 mt-2 max-h-[85vh] overflow-y-auto rounded-2xl border border-white/15 bg-[#0b0e15] p-4 shadow-2xl animate-in fade-in slide-in-from-top-2 duration-200">
            <div className="flex flex-col gap-4">
              {/* Primary Apps Section */}
              <div>
                <div className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2 px-1">
                  Apps & Services
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {PRIMARY_LINKS.map((link) => {
                    const active = isActive(link.href);
                    return (
                      <Link
                        key={link.href}
                        href={link.href}
                        onClick={() => setMobileOpen(false)}
                        className={`flex items-center gap-2 rounded-xl p-2.5 text-xs font-medium border transition ${
                          active
                            ? "border-sky-500/40 bg-sky-500/15 text-sky-200"
                            : "border-white/5 bg-white/5 text-gray-300 hover:bg-white/10 hover:text-white"
                        }`}
                      >
                        <span>{link.label}</span>
                      </Link>
                    );
                  })}
                </div>
              </div>

              {/* Developer & Tools Section */}
              <div className="border-t border-white/10 pt-3">
                <div className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-2 px-1">
                  Tools & Analytics
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  {MORE_LINKS.map((link) =>
                    link.external ? (
                      <a
                        key={link.href}
                        href={link.href}
                        target="_blank"
                        rel="noreferrer"
                        onClick={() => setMobileOpen(false)}
                        className="flex items-center justify-between gap-1 rounded-xl border border-white/5 bg-white/5 p-2.5 text-xs font-medium text-gray-300 hover:bg-white/10 hover:text-white transition"
                      >
                        <span className="truncate">{link.label}</span>
                        {link.badge && (
                          <span className="text-[9px] font-bold text-amber-300 bg-amber-500/15 border border-amber-500/30 px-1 py-0.2 rounded shrink-0">
                            {link.badge}
                          </span>
                        )}
                      </a>
                    ) : (
                      <Link
                        key={link.href}
                        href={link.href}
                        onClick={() => setMobileOpen(false)}
                        className={`flex items-center justify-between gap-1 rounded-xl p-2.5 text-xs font-medium border transition ${
                          isActive(link.href)
                            ? "border-sky-500/40 bg-sky-500/15 text-sky-200"
                            : "border-white/5 bg-white/5 text-gray-300 hover:bg-white/10 hover:text-white"
                        }`}
                      >
                        <span className="truncate">{link.label}</span>
                        {link.badge && (
                          <span className="text-[9px] font-bold text-amber-300 bg-amber-500/15 border border-amber-500/30 px-1 py-0.2 rounded shrink-0">
                            {link.badge}
                          </span>
                        )}
                      </Link>
                    )
                  )}
                </div>
              </div>

              {/* Footer Links inside Mobile Menu */}
              <div className="border-t border-white/10 pt-3 flex items-center justify-between text-xs text-gray-400 px-1">
                <a
                  href="https://x.com/sukrutkrdg"
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-1.5 text-sky-400 hover:underline"
                >
                  <svg viewBox="0 0 24 24" className="h-3.5 w-3.5" fill="currentColor">
                    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817-5.97 6.817H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
                  </svg>
                  <span>@sukrutkrdg on X</span>
                </a>
                <span className="text-[10px] text-gray-500">Base · NEAR</span>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
