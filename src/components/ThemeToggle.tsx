"use client";

import { useEffect, useState } from "react";

type Theme = "dark" | "light" | "system";

function apply(theme: Theme) {
  const dark =
    theme === "dark" || (theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.classList.toggle("light", !dark);
}

/** Cycles dark → light → system, persists the choice, and follows the OS in system mode. */
export default function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>("system");

  useEffect(() => {
    const saved = (localStorage.getItem("theme") as Theme | null) ?? "system";
    setTheme(saved);
    apply(saved);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => {
      if ((localStorage.getItem("theme") as Theme | null ?? "system") === "system") apply("system");
    };
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  function cycle() {
    const next: Theme = theme === "dark" ? "light" : theme === "light" ? "system" : "dark";
    setTheme(next);
    localStorage.setItem("theme", next);
    apply(next);
  }

  const icon = theme === "dark" ? "🌙" : theme === "light" ? "☀️" : "🖥️";
  const labels: Record<Theme, string> = { dark: "Dark", light: "Light", system: "System" };
  return (
    <button
      onClick={cycle}
      aria-label={`Theme: ${labels[theme]} (click to change)`}
      title={`Theme: ${labels[theme]}`}
      className="shrink-0 grid h-8 w-8 place-items-center rounded-lg text-base hover:bg-white/5"
    >
      {icon}
    </button>
  );
}
