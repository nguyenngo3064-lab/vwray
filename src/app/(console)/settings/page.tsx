"use client";

import { useEffect, useState } from "react";
import { Button, Input, Panel, Select } from "@/components/ui/primitives";
import { apiFetch } from "@/lib/api/client";

interface SettingRow {
  key: string;
  category: string;
  description: string;
  impact: string | null;
  sensitive: boolean;
  value: unknown;
  defaultValue: unknown;
  isDefault: boolean;
  shape: "boolean" | "number" | "string" | "list" | "object";
}

type Language = "en" | "vi";

const labels: Record<Language, Record<string, string>> = {
  en: {
    title: "Settings",
    subtitle: "Control access, security, traffic, quota and gateway behavior.",
    language: "Language",
    languageHint: "Changes the console navigation language on this browser.",
    english: "English",
    vietnamese: "Tiếng Việt",
    save: "Save",
    saved: "Saved",
    default: "Default",
    sensitive: "Sensitive",
    impact: "Impact",
    loading: "Loading settings...",
    failed: "Unable to load settings.",
  },
  vi: {
    title: "Cài đặt",
    subtitle: "Điều khiển truy cập, bảo mật, lưu lượng, quota và gateway.",
    language: "Ngôn ngữ",
    languageHint: "Thay đổi ngôn ngữ menu trên trình duyệt này.",
    english: "English",
    vietnamese: "Tiếng Việt",
    save: "Lưu",
    saved: "Đã lưu",
    default: "Mặc định",
    sensitive: "Nhạy cảm",
    impact: "Tác động",
    loading: "Đang tải cài đặt...",
    failed: "Không thể tải cài đặt.",
  },
};

function displayValue(value: unknown, shape: SettingRow["shape"]): string {
  if (shape === "boolean") return value === true ? "true" : "false";
  if (shape === "list" || shape === "object") return JSON.stringify(value, null, 2);
  return value === null || value === undefined ? "" : String(value);
}

export default function SettingsPage() {
  const [language, setLanguage] = useState<Language>("en");
  const [settings, setSettings] = useState<SettingRow[]>([]);
  const [values, setValues] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const text = labels[language];

  useEffect(() => {
    const stored = window.localStorage.getItem("vwray_language");
    if (stored === "en" || stored === "vi") setLanguage(stored);
    apiFetch<SettingRow[]>("/api/settings")
      .then((rows) => {
        setSettings(rows);
        setValues(Object.fromEntries(rows.map((row) => [row.key, displayValue(row.value, row.shape)])));
      })
      .catch((caught: unknown) => setError(caught instanceof Error ? caught.message : text.failed));
  }, [text.failed]);

  function changeLanguage(next: Language) {
    setLanguage(next);
    window.localStorage.setItem("vwray_language", next);
    window.dispatchEvent(new CustomEvent("vwray:language", { detail: next }));
  }

  async function saveSetting(row: SettingRow) {
    setSaving(row.key);
    setSaved(null);
    setError(null);
    let value: unknown = values[row.key] ?? "";
    try {
      if (row.shape === "boolean") value = value === "true";
      if (row.shape === "number") value = Number(value);
      if (row.shape === "list" || row.shape === "object") value = JSON.parse(String(value));
      await apiFetch(`/api/settings`, { method: "PATCH", body: { key: row.key, value } });
      setSaved(row.key);
    } catch (caught: unknown) {
      setError(caught instanceof Error ? caught.message : "Unable to save setting.");
    } finally {
      setSaving(null);
    }
  }

  const grouped = settings.reduce<Record<string, SettingRow[]>>((groups, row) => {
    (groups[row.category] ??= []).push(row);
    return groups;
  }, {});

  return (
    <div className="space-y-4 p-4 lg:p-6">
      <div>
        <h1 className="text-lg font-semibold text-primary">{text.title}</h1>
        <p className="text-[12.5px] text-muted">{text.subtitle}</p>
      </div>

      <Panel title={text.language} bodyClassName="space-y-2 p-4">
        <Select value={language} onChange={(event) => changeLanguage(event.target.value as Language)}>
          <option value="en">{text.english}</option>
          <option value="vi">{text.vietnamese}</option>
        </Select>
        <p className="text-[11.5px] text-faint">{text.languageHint}</p>
      </Panel>

      {error ? <p className="text-[12px] text-danger" role="alert">{error}</p> : null}
      {settings.length === 0 && !error ? <p className="text-[12px] text-muted">{text.loading}</p> : null}

      {Object.entries(grouped).map(([category, rows]) => (
        <Panel key={category} title={category} bodyClassName="divide-y divide-border p-0">
          {rows.map((row) => (
            <div key={row.key} className="grid gap-3 p-4 lg:grid-cols-[minmax(0,1fr)_minmax(14rem,24rem)_auto] lg:items-start">
              <div className="space-y-1">
                <p className="font-mono text-[12px] text-primary">{row.key}</p>
                <p className="text-[12px] leading-relaxed text-muted">{row.description}</p>
                {row.impact ? <p className="text-[11px] leading-relaxed text-warning">{text.impact}: {row.impact}</p> : null}
                <div className="flex gap-2 text-[10px] text-faint">
                  {row.isDefault ? <span>{text.default}</span> : null}
                  {row.sensitive ? <span>{text.sensitive}</span> : null}
                </div>
              </div>
              {row.shape === "boolean" ? (
                <Select value={values[row.key] ?? "false"} onChange={(event) => setValues((current) => ({ ...current, [row.key]: event.target.value }))}>
                  <option value="true">true</option>
                  <option value="false">false</option>
                </Select>
              ) : row.shape === "list" || row.shape === "object" ? (
                <textarea className="input min-h-20 w-full resize-y font-mono text-[11px]" value={values[row.key] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [row.key]: event.target.value }))} />
              ) : (
                <Input type={row.shape === "number" ? "number" : "text"} value={values[row.key] ?? ""} onChange={(event) => setValues((current) => ({ ...current, [row.key]: event.target.value }))} />
              )}
              <Button variant="primary" onClick={() => void saveSetting(row)} disabled={saving === row.key}>
                {saving === row.key ? "..." : saved === row.key ? text.saved : text.save}
              </Button>
            </div>
          ))}
        </Panel>
      ))}
    </div>
  );
}
