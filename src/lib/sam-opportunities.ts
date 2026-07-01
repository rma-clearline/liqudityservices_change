export type SamOpportunity = {
  notice_id: string;
  title: string;
  solicitation_number: string | null;
  organization: string | null;
  posted_date: string | null;
  response_deadline: string | null;
  notice_type: string | null;
  base_type: string | null;
  naics_code: string | null;
  classification_code: string | null;
  description_url: string | null;
  ui_link: string | null;
  awardee_name: string | null;
  awardee_uei: string | null;
  award_amount: number | null;
  award_date: string | null;
  set_aside: string | null;
  pop_state: string | null;
  pop_city: string | null;
};

type SamRaw = {
  noticeId?: string;
  title?: string;
  solicitationNumber?: string;
  fullParentPathName?: string;
  postedDate?: string;
  responseDeadLine?: string;
  type?: string;
  baseType?: string;
  naicsCode?: string;
  classificationCode?: string;
  description?: string;
  uiLink?: string;
  typeOfSetAside?: string;
  typeOfSetAsideDescription?: string;
  placeOfPerformance?: {
    city?: { name?: string };
    state?: { code?: string; name?: string };
  };
  award?: {
    date?: string;
    amount?: string | number;
    awardee?: { name?: string; ueiSAM?: string };
  };
};

// GSA docs show both URL variants in different examples. We try both.
const SAM_ENDPOINTS = [
  "https://api.sam.gov/opportunities/v2/search",
  "https://api.sam.gov/prod/opportunities/v2/search",
];

// SAM.gov accepts the key either as a query param (opportunities API docs) or
// as an X-Api-Key header (entity/extracts API docs). Try both.
type AuthMode = "query" | "header";
const AUTH_MODES: AuthMode[] = ["query", "header"];

function fmtDate(d: Date): string {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

function mapOpportunity(raw: SamRaw): SamOpportunity | null {
  if (!raw.noticeId || !raw.title) return null;
  const award = raw.award;
  const amount = award?.amount != null ? Number(award.amount) : null;
  return {
    notice_id: raw.noticeId,
    title: raw.title,
    solicitation_number: raw.solicitationNumber ?? null,
    organization: raw.fullParentPathName ?? null,
    posted_date: raw.postedDate ?? null,
    response_deadline: raw.responseDeadLine ?? null,
    notice_type: raw.type ?? null,
    base_type: raw.baseType ?? null,
    naics_code: raw.naicsCode ?? null,
    classification_code: raw.classificationCode ?? null,
    description_url: raw.description ?? null,
    ui_link: raw.uiLink ?? null,
    awardee_name: award?.awardee?.name ?? null,
    awardee_uei: award?.awardee?.ueiSAM ?? null,
    award_amount: amount != null && Number.isFinite(amount) ? amount : null,
    award_date: award?.date ?? null,
    set_aside: raw.typeOfSetAsideDescription ?? raw.typeOfSetAside ?? null,
    pop_state: raw.placeOfPerformance?.state?.code ?? raw.placeOfPerformance?.state?.name ?? null,
    pop_city: raw.placeOfPerformance?.city?.name ?? null,
  };
}

// Build a query string without percent-encoding forward slashes in date values.
// SAM dates use MM/DD/YYYY and some gateways reject %2F-encoded slashes.
function buildQs(params: Record<string, string>): string {
  return Object.entries(params)
    .map(([k, v]) => `${k}=${encodeURIComponent(v).replace(/%2F/gi, "/")}`)
    .join("&");
}

// Common browser headers — some SAM.gov gateways 404 requests without a UA.
const COMMON_HEADERS = {
  Accept: "application/json",
  "User-Agent": "LQDT-Tracker/1.0 (+https://github.com/mgm100-cloud/liqudityservices)",
};

type WorkingConfig = { endpoint: string; authMode: AuthMode };
let workingConfig: WorkingConfig | null = null;

async function tryOne(
  endpoint: string,
  authMode: AuthMode,
  apiKey: string,
  params: Record<string, string>,
): Promise<{ ok: true; data: SamOpportunity[] } | { ok: false; status: number; body: string } | { ok: false; status: -1; body: string }> {
  const qsParams = authMode === "query" ? { api_key: apiKey, ...params } : params;
  const url = `${endpoint}?${buildQs(qsParams)}`;
  const headers: Record<string, string> = { ...COMMON_HEADERS };
  if (authMode === "header") headers["X-Api-Key"] = apiKey;

  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return { ok: false, status: res.status, body };
    }
    const data = await res.json();
    const raw: SamRaw[] = Array.isArray(data?.opportunitiesData) ? data.opportunitiesData : [];
    const mapped: SamOpportunity[] = [];
    for (const r of raw) {
      const m = mapOpportunity(r);
      if (m) mapped.push(m);
    }
    return { ok: true, data: mapped };
  } catch (err) {
    return { ok: false, status: -1, body: err instanceof Error ? err.message : String(err) };
  }
}

async function samFetch(
  apiKey: string,
  params: Record<string, string>,
): Promise<SamOpportunity[]> {
  // Once we've found a working config, stick to it.
  if (workingConfig) {
    const r = await tryOne(workingConfig.endpoint, workingConfig.authMode, apiKey, params);
    if (r.ok) return r.data;
    console.error(`[sam] HTTP ${r.status} via cached config (${workingConfig.authMode} auth): ${r.body.slice(0, 200)}`);
    return [];
  }

  // Probe all combinations until one succeeds. Log each attempt.
  for (const endpoint of SAM_ENDPOINTS) {
    for (const authMode of AUTH_MODES) {
      const r = await tryOne(endpoint, authMode, apiKey, params);
      if (r.ok) {
        workingConfig = { endpoint, authMode };
        console.log(`[sam] found working config: endpoint=${endpoint} auth=${authMode}`);
        return r.data;
      }
      const label = `${endpoint.replace("https://api.sam.gov", "")} auth=${authMode}`;
      console.warn(`[sam] ${label} → HTTP ${r.status}: ${r.body.slice(0, 150) || "(empty)"}`);
    }
  }

  console.error(
    "[sam] all 4 URL×auth combinations failed. Likely cause: the SAM_API_KEY is not authorized for the Opportunities API. " +
      "Generate a new key at sam.gov → Profile → Account Details → API Key, and ensure your account has opportunities access.",
  );
  return [];
}

// LQDT identity: UEI + company/brand names that appear as awardee on federal contracts.
const LQDT_UEI = "WJV4A6AM6ZN6";
const LQDT_NAME_PATTERNS = [
  "liquidity services",
  "govdeals",
  "allsurplus",
  "bid4assets",
  "government liquidation",
  "govplanet",
  "network international",
];

// Brand-name title searches (awardee often unset on solicitations).
const TITLE_TERMS = [
  "liquidity services",
  "govdeals",
  "allsurplus",
  "bid4assets",
  "government liquidation",
];

// NAICS codes where LQDT commonly appears as an awardee; results are still
// filtered to LQDT by UEI/name, so extra codes only widen the candidate net.
const NAICS_CODES = ["561499", "423930", "454110", "561990"];

function matchesLqdt(opp: SamOpportunity): boolean {
  if (opp.awardee_uei && opp.awardee_uei.toUpperCase() === LQDT_UEI) return true;
  const name = (opp.awardee_name ?? "").toLowerCase();
  if (name && LQDT_NAME_PATTERNS.some((p) => name.includes(p))) return true;
  return false;
}

export async function fetchSamOpportunities(daysBack = 90): Promise<{
  opportunities: SamOpportunity[];
  debug: string;
}> {
  const apiKey = process.env.SAM_API_KEY;
  if (!apiKey) {
    console.error("[sam] SAM_API_KEY not set");
    return { opportunities: [], debug: "SAM_API_KEY not set" };
  }

  console.log(`[sam] API key present (${apiKey.length} chars, starts with ${apiKey.slice(0, 4)}…)`);

  const now = new Date();
  const from = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
  const postedFrom = fmtDate(from);
  const postedTo = fmtDate(now);

  // Probe first to find the working endpoint/auth combo.
  await samFetch(apiKey, { postedFrom, postedTo, limit: "1" });
  if (!workingConfig) {
    return {
      opportunities: [],
      debug: "probe failed — all endpoint/auth combos returned non-OK (invalid key or endpoint down)",
    };
  }

  // Strategy: the API has no awardee filter, so we fetch candidate sets and
  // post-filter to only opportunities where the awardee is actually LQDT
  // (matched by UEI or brand-name substring).
  //
  // Candidate sources:
  //  (a) title searches for LQDT brand names — catches opps that name LQDT
  //      explicitly (works for solicitations where awardee is unset)
  //  (b) award-type searches (ptype=a) in LQDT's NAICS codes, where we can
  //      cross-check awardee UEI/name
  const titleSearches = TITLE_TERMS.map((title) =>
    samFetch(apiKey, { postedFrom, postedTo, title, limit: "200" }),
  );
  const awardSearches = NAICS_CODES.map((ncode) =>
    samFetch(apiKey, { postedFrom, postedTo, ncode, ptype: "a", limit: "1000" }),
  );
  const [titleResults, awardResults] = await Promise.all([
    Promise.all(titleSearches),
    Promise.all(awardSearches),
  ]);

  const titleHits = titleResults.flat();
  const awardCandidates = awardResults.flat();
  const candidateCount = titleHits.length + awardCandidates.length;

  // Title-keyword hits already match an LQDT brand in the title; keep them all.
  // For broader award-type searches, keep only records whose awardee matches LQDT.
  const keepers = [...titleHits, ...awardCandidates.filter(matchesLqdt)];

  const seen = new Set<string>();
  const opportunities: SamOpportunity[] = [];
  for (const opp of keepers) {
    if (seen.has(opp.notice_id)) continue;
    seen.add(opp.notice_id);
    opportunities.push(opp);
  }

  const titleCounts = titleResults.map((r) => r.length).join("/");
  const awardCounts = awardResults.map((r) => r.length).join("/");
  return {
    opportunities,
    debug: `endpoint:${workingConfig?.endpoint} auth:${workingConfig?.authMode} titles[${TITLE_TERMS.join("/")}]:${titleCounts} awards[${NAICS_CODES.join("/")}]:${awardCounts} candidates:${candidateCount} lqdt_matched:${opportunities.length}`,
  };
}
