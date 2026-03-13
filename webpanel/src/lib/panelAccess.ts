const PANEL_ACCESS_KEYS = [
  "panelAccessEnabled",
  "accessToPanel",
  "panelActive",
  "panelEnabled",
  "webPanelEnabled",
  "webpanelEnabled",
];

function truthy(value: unknown): boolean {
  if (value === true) return true;
  if (typeof value === "number") return Number.isFinite(value) && value !== 0;
  const text = String(value ?? "").trim().toLowerCase();
  return text === "true" || text === "1" || text === "yes" || text === "on";
}

export function isPanelEnabled(value: unknown): boolean {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const obj = value as Record<string, unknown>;
    return PANEL_ACCESS_KEYS.some((key) => truthy(obj[key]));
  }
  return truthy(value);
}

export { PANEL_ACCESS_KEYS };
