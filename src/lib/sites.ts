// Human-readable labels for LQDT marketplace/site codes (Maestro `businessId`).
//  AD = AllSurplus  — commercial + state/local government surplus marketplace
//  GD = GovDeals    — government (state/local/federal agency) surplus marketplace
//  GI = GoIndustry  — industrial / capital-equipment assets
// Isomorphic (client + server safe).

export const SITE_LABELS: Record<string, string> = {
  AD: "AllSurplus",
  GD: "GovDeals",
  GI: "Industrial",
};

/** Full name for a site code, e.g. "GD" → "GovDeals". Unknown codes pass through. */
export function siteLabel(code: string | null | undefined): string {
  if (!code) return "Unknown";
  return SITE_LABELS[code] ?? code;
}

/** "GovDeals (GD)" — full name with the code, for dropdowns/legends. */
export function siteLabelWithCode(code: string): string {
  const l = SITE_LABELS[code];
  return l ? `${l} (${code})` : code;
}
