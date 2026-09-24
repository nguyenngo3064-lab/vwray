"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useState } from "react";

const navigation = [
  ["devices", "/devices"],
  ["nodes", "/nodes"],
  ["configurations", "/configurations"],
  ["quota", "/quota"],
  ["optimization", "/optimization"],
  ["dns", "/dns"],
  ["settings", "/settings"],
] as const;

const navigationLabels = {
  en: { devices: "Devices", nodes: "Nodes", configurations: "Configurations", quota: "Quota", optimization: "Optimization", dns: "DNS", settings: "Settings", publicUrl: "PUBLIC URL", copy: "Copy URL", copied: "Copied" },
  vi: { devices: "Thiết bị", nodes: "Node VPN", configurations: "Cấu hình", quota: "Giới hạn", optimization: "Tối ưu", dns: "DNS", settings: "Cài đặt", publicUrl: "URL CÔNG KHAI", copy: "Sao chép URL", copied: "Đã sao chép" },
} as const;

export function ConsoleShell({ publicUrl, children }: { publicUrl: string; children: React.ReactNode }) {
  const pathname = usePathname();
  const [copied, setCopied] = useState(false);
  const [language, setLanguage] = useState<"en" | "vi">("en");
  const labels = navigationLabels[language];

  useEffect(() => {
    const stored = window.localStorage.getItem("vwray_language");
    if (stored === "en" || stored === "vi") setLanguage(stored);
    const onLanguage = (event: Event) => {
      const next = (event as CustomEvent<string>).detail;
      if (next === "en" || next === "vi") setLanguage(next);
    };
    window.addEventListener("vwray:language", onLanguage);
    return () => window.removeEventListener("vwray:language", onLanguage);
  }, []);

  async function copyPublicUrl() {
    await navigator.clipboard.writeText(publicUrl);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="min-h-dvh lg:grid lg:grid-cols-[15rem_1fr]">
      <aside className="border-b border-border bg-surface lg:min-h-dvh lg:border-b-0 lg:border-r">
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3 lg:block">
          <Link href="/devices" className="text-sm font-semibold tracking-tight text-primary">
            VWRAY
          </Link>
          <span className="micro-label">CONTROL PLANE</span>
        </div>
        <nav aria-label="Console menu" className="flex gap-1 overflow-x-auto p-3 lg:block lg:space-y-1">
          {navigation.map(([key, href]) => {
            const active = pathname === href;
            return (
              <Link
                key={href}
                href={href}
                className={`block whitespace-nowrap border px-3 py-2 text-[12px] ${
                  active
                    ? "border-border-strong bg-elevated text-primary"
                    : "border-transparent text-muted hover:border-border hover:text-primary"
                }`}
              >
                {labels[key]}
              </Link>
            );
          })}
        </nav>
        <div className="border-t border-border p-3">
          <p className="micro-label mb-1.5">{labels.publicUrl}</p>
          <p className="break-all font-mono text-[11px] leading-relaxed text-muted">{publicUrl}</p>
          <button type="button" className="btn mt-2 w-full" onClick={copyPublicUrl}>
            {copied ? labels.copied : labels.copy}
          </button>
        </div>
      </aside>
      <main className="min-w-0">{children}</main>
    </div>
  );
}