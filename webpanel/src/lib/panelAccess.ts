const PANEL_KEYS = [
  "panelAccessEnabled",
  "accessToPanel",
  "panelActive",
  "panelEnabled",
  "webpanelEnabled",
  "webPanelEnabled",
];

function toBool(value: unknown): boolean {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === "number") return value !== 0;
  const text = String(value ?? "").trim().toLowerCase();
  return text === "true" || text === "1" || text === "yes" || text === "on" || text === "enabled" || text === "active";
}

export function isPanelEnabled(value: unknown): boolean {
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const first = PANEL_KEYS.map((key) => record[key]).find((candidate) => candidate !== undefined && candidate !== null);
    return toBool(first);
  }
  return toBool(value);
}
