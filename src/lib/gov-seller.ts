// Classify a marketplace seller by level of government (or commercial).
//
// LQDT's marketplaces (AllSurplus/GovDeals) are dominated by *government*
// surplus sellers — mostly state & local, with a thin federal presence (federal
// surplus largely flows through the DoD/DLA AllSurplus program and GSA Auctions,
// not the open feed). An analyst tracking LQDT's government-surplus franchise
// wants the mix by level, which we derive from the seller's company name.
//
// This is a name-based heuristic — deliberately conservative. When markers are
// absent or ambiguous we fall back to "commercial" so the government buckets
// aren't inflated. Order of checks matters: the most distinctive markers
// (federal agencies, then city/county/school) are tested before broader ones.

export type GovLevel = "federal" | "state" | "local" | "commercial";

// Federal agencies / departments / military (checked first — most specific).
const FEDERAL = [
  /\bfederal\b/i,
  /\bu\.?\s?s\.?\s+(department|army|navy|air\s?force|marshals?|mint|coast\s?guard|forest|postal|customs|fish)/i,
  /united states\b/i,
  /department of defense|\bdod\b/i,
  /defense logistics|\bdla\b|disposition services/i,
  /general services administration|\bgsa\b/i,
  /\b(naval|marine corps|air force base|\bafb\b|army depot|army corps|national guard)\b/i,
  /veterans affairs|\bva\b medical|veterans (health|benefits)/i,
  /postal service|\busps\b/i,
  /\b(nasa|faa|tsa|fbi|atf|dea|irs|usda|epa|noaa|cbp|ice|nps)\b/i,
  /homeland security|\bdhs\b/i,
  /bureau of (land management|prisons|reclamation|indian affairs|engraving)/i,
  /national park service|smithsonian|forest service/i,
];

// City / county / municipal / school-district / public-safety (very distinctive).
const LOCAL = [
  /\b(city|town|village|borough|township)\s+of\b/i,
  /\bcounty\b/i,
  /\bmunicipal(ity)?\b/i,
  /school district|unified school|public schools|\bisd\b|\bcusd\b/i,
  /community college/i,
  /\bsheriff('s)?\b|police department|\bpd\b|fire department|fire district|\bfire rescue\b/i,
  /transit authority|housing authority|water district|utility district|public utilit|sanitation district|metropolitan\b/i,
  /parks (and|&) recreation/i,
];

// State-level markers (checked after local so "State of X County" edge cases
// resolve to local first only when they carry local markers).
const STATE = [
  /\bstate of\b|commonwealth of\b/i,
  /\buniversity of\b|state university|state college\b/i,
  /\bdepartment of (transportation|corrections|natural resources|motor vehicles|revenue|administration|general services)\b/i,
  /\b(dot|dmv|dnr)\b/i,
  /\bstate\s+(police|patrol|university|hospital|agency|surplus)\b/i,
];

function anyMatch(name: string, patterns: RegExp[]): boolean {
  return patterns.some((p) => p.test(name));
}

/** Classify a seller's government level from its company name. */
export function classifySellerLevel(companyName: string | null | undefined): GovLevel {
  const name = (companyName ?? "").trim();
  if (!name) return "commercial";
  if (anyMatch(name, FEDERAL)) return "federal";
  if (anyMatch(name, LOCAL)) return "local";
  if (anyMatch(name, STATE)) return "state";
  return "commercial";
}

