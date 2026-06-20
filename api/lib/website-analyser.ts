/**
 * Multi-page website analyser for business onboarding.
 *
 * Crawls the homepage plus key internal pages, extracts structured evidence,
 * and computes a confidence score before any marketing strategy is generated.
 */

export interface CrawledPage {
  url: string;
  path: string;
  title: string;
  metaDescription: string;
  ogTitle: string;
  ogDescription: string;
  h1: string[];
  h2: string[];
  h3: string[];
  text: string;
  links: string[];
  emails: string[];
  phones: string[];
  socialLinks: string[];
  structuredData: string[];
  fetched: boolean;
  status?: number;
  error?: string;
  errorCode?: WebsiteAnalysisErrorCode;
  redirectUrl?: string;
  contentLength?: number;
}

export interface WebsiteAnalysisLog {
  rawWebsiteInput: string;
  normalizedUrl: string;
  normalizationError?: string;
  fetchAttemptedUrls: string[];
  statusCode?: number;
  redirectUrl?: string;
  contentLength?: number;
  pagesCrawled: number;
  pagesFetched: number;
  confidence: number;
  failureReason?: string;
  errorCode?: string;
}

export interface WebsiteAnalysisResult {
  pages: CrawledPage[];
  evidence: BusinessEvidence;
  log: WebsiteAnalysisLog;
}

export interface RepeatedKeyword {
  keyword: string;
  count: number;
}

export interface BusinessEvidence {
  businessCategory: string;
  productsServices: string[];
  targetCustomers: string[];
  contactDetails: {
    email?: string;
    phone?: string;
    address?: string;
    socialLinks?: string[];
  };
  location: string;
  repeatedKeywords: RepeatedKeyword[];
  evidenceSnippets: string[];
  confidence: number;
  assumptions: string[];
}

const STOP_WORDS = new Set([
  "and", "the", "for", "with", "you", "your", "our", "are", "from", "have",
  "more", "home", "about", "contact", "this", "that", "will", "can", "all",
  "any", "may", "not", "but", "was", "were", "been", "has", "had", "its",
  "they", "them", "their", "there", "when", "where", "what", "how", "who",
  "why", "which", "while", "during", "before", "after", "above", "below",
  "between", "through", "over", "under", "again", "further", "then", "once",
  "here", "there", "each", "few", "other", "some", "such", "only", "own",
  "same", "so", "than", "too", "very", "just", "now",
]);

const SERVICE_INVENTION_BLOCKLIST = [
  "seo", "social media management", "content creation", "data analytics",
  "digital marketing", "restaurant services", "salon services", "consulting",
];

const KEY_INTERNAL_PATHS = [
  "/about", "/about-us", "/our-story",
  "/services", "/what-we-do", "/solutions",
  "/products", "/shop", "/store", "/catalogue", "/catalog",
  "/portfolio", "/work", "/gallery",
  "/menu", "/pricing", "/price-list", "/rates",
  "/contact", "/contact-us", "/get-in-touch",
  "/faq", "/frequently-asked-questions",
];

export type WebsiteAnalysisErrorCode =
  | "INVALID_URL"
  | "UNREACHABLE"
  | "TIMEOUT"
  | "BLOCKED"
  | "SERVER_ERROR"
  | "NO_CONTENT"
  | "UNKNOWN";

export interface NormalizedUrl {
  url: string;
  rawInput: string;
  error?: WebsiteAnalysisErrorCode;
}

function normalizeUrl(input: string): NormalizedUrl {
  const rawInput = input.trim();
  if (!rawInput) {
    return { url: "", rawInput, error: "INVALID_URL" };
  }

  let url = rawInput;
  // Add protocol if missing. Accept inputs like zutohub.co.za, www.zutohub.co.za,
  // https://zutohub.co.za, https://www.zutohub.co.za, ZutoHub.co.za.
  if (!/^https?:\/\//i.test(url)) {
    url = "https://" + url;
  }

  try {
    const parsed = new URL(url);
    // Hostnames are case-insensitive; lowercase avoids fetch issues and keeps logs clean.
    parsed.hostname = parsed.hostname.toLowerCase();
    return { url: parsed.origin, rawInput };
  } catch {
    return { url, rawInput, error: "INVALID_URL" };
  }
}

function resolveLink(href: string, baseUrl: string): string | null {
  try {
    const resolved = new URL(href, baseUrl).href;
    const base = new URL(baseUrl).origin;
    if (!resolved.startsWith(base)) return null;
    return resolved;
  } catch {
    return null;
  }
}

function stripHtml(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTag(html: string, tag: string): string[] {
  const regex = new RegExp(`<${tag}[^>]*>([^<]*)<\\/${tag}>`, "gi");
  const matches: string[] = [];
  let m;
  while ((m = regex.exec(html)) !== null) {
    const text = m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (text) matches.push(text);
  }
  return matches;
}

function extractMeta(html: string, name: string): string {
  const regex = new RegExp(
    `<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']+)["']`,
    "i"
  );
  const match = html.match(regex);
  if (match) return match[1].trim();
  const regex2 = new RegExp(
    `<meta[^>]+content=["']([^"']+)["'][^>]+(?:name|property)=["']${name}["']`,
    "i"
  );
  const match2 = html.match(regex2);
  return match2 ? match2[1].trim() : "";
}

function extractLinks(html: string, baseUrl: string): string[] {
  const links: string[] = [];
  const regex = /<a[^>]+href=["']([^"']+)["']/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const resolved = resolveLink(m[1], baseUrl);
    if (resolved) links.push(resolved);
  }
  return Array.from(new Set(links));
}

function extractEmails(text: string): string[] {
  const matches = text.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  return Array.from(new Set(matches)).filter((e) => !e.endsWith(".png") && !e.endsWith(".jpg"));
}

function extractPhones(text: string): string[] {
  const matches = text.match(/(?:tel:|\+?\d[\d\s\-().]{7,}\d)/g) || [];
  return Array.from(new Set(matches)).map((p) => p.replace(/^tel:/, "").trim());
}

function extractSocialLinks(links: string[]): string[] {
  const platforms = ["facebook.com", "instagram.com", "linkedin.com", "twitter.com", "x.com", "tiktok.com", "youtube.com", "pinterest.com"];
  return links.filter((l) => platforms.some((p) => l.toLowerCase().includes(p)));
}

function extractStructuredData(html: string): string[] {
  const matches: string[] = [];
  const regex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = regex.exec(html)) !== null) {
    const text = m[1].trim();
    if (text) matches.push(text);
  }
  return matches;
}

function classifyFetchError(err: any, status?: number): { error: string; code: WebsiteAnalysisErrorCode } {
  if (status !== undefined) {
    if (status >= 500) return { error: `Server error (HTTP ${status})`, code: "SERVER_ERROR" };
    if (status === 403 || status === 401 || status === 407) return { error: `Access blocked (HTTP ${status})`, code: "BLOCKED" };
    if (status === 404 || status === 410) return { error: `Page not found (HTTP ${status})`, code: "UNREACHABLE" };
    if (status >= 400) return { error: `Client error (HTTP ${status})`, code: "BLOCKED" };
  }

  const message = err?.message || String(err) || "";
  const name = err?.name || "";

  if (name === "AbortError" || message.includes("abort") || message.includes("timeout") || message.includes("Timeout")) {
    return { error: "Request timed out", code: "TIMEOUT" };
  }
  if (message.includes("ENOTFOUND") || message.includes("getaddrinfo") || message.includes("ECONNREFUSED") || message.includes("ECONNRESET")) {
    return { error: `Website unreachable (${message})`, code: "UNREACHABLE" };
  }
  if (message.includes("certificate") || message.includes("SSL") || message.includes("TLS")) {
    return { error: `SSL/TLS error (${message})`, code: "UNREACHABLE" };
  }
  if (message.includes("blocked") || message.includes("forbidden") || message.includes("denied")) {
    return { error: `Access blocked (${message})`, code: "BLOCKED" };
  }

  return { error: message || "Unknown fetch error", code: "UNKNOWN" };
}

function emptyCrawledPage(url: string, path: string): CrawledPage {
  return {
    url,
    path,
    title: "",
    metaDescription: "",
    ogTitle: "",
    ogDescription: "",
    h1: [],
    h2: [],
    h3: [],
    text: "",
    links: [],
    emails: [],
    phones: [],
    socialLinks: [],
    structuredData: [],
    fetched: false,
  };
}

async function fetchPage(url: string, timeoutMs = 6000): Promise<CrawledPage> {
  let path = "/";
  try {
    path = new URL(url).pathname || "/";
  } catch {
    // If the URL is so malformed we can't parse it, still return a failed page object.
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        Accept: "text/html",
      },
      signal: controller.signal,
      redirect: "follow",
    });
    clearTimeout(timer);

    const redirectUrl = res.url !== url ? res.url : undefined;
    const contentLength = res.headers.get("content-length")
      ? parseInt(res.headers.get("content-length") || "0", 10)
      : undefined;

    if (!res.ok) {
      const { error, code } = classifyFetchError(undefined, res.status);
      return {
        ...emptyCrawledPage(url, path),
        fetched: false,
        status: res.status,
        error,
        errorCode: code,
        redirectUrl,
        contentLength,
      };
    }

    const html = await res.text();
    const links = extractLinks(html, url);
    const text = stripHtml(html);

    if (!text.trim()) {
      return {
        ...emptyCrawledPage(url, path),
        fetched: false,
        status: res.status,
        error: "No usable text content found",
        redirectUrl,
        contentLength,
      };
    }

    return {
      url,
      path,
      title: extractTag(html, "title")[0] || "",
      metaDescription: extractMeta(html, "description"),
      ogTitle: extractMeta(html, "og:title"),
      ogDescription: extractMeta(html, "og:description"),
      h1: extractTag(html, "h1"),
      h2: extractTag(html, "h2"),
      h3: extractTag(html, "h3"),
      text: text.length > 5000 ? text.slice(0, 5000) + "..." : text,
      links,
      emails: extractEmails(text),
      phones: extractPhones(text),
      socialLinks: extractSocialLinks(links),
      structuredData: extractStructuredData(html),
      fetched: true,
      status: res.status,
      redirectUrl,
      contentLength,
    };
  } catch (err: any) {
    clearTimeout(timer);
    const { error, code } = classifyFetchError(err);
    return {
      ...emptyCrawledPage(url, path),
      fetched: false,
      error,
      errorCode: code,
    };
  }
}

export async function crawlWebsitePages(
  baseUrl: string,
  opts?: { maxPages?: number; timeoutMs?: number }
): Promise<WebsiteAnalysisResult> {
  const { url: normalized, rawInput, error: normalizationError } = normalizeUrl(baseUrl);
  const maxPages = opts?.maxPages ?? 10;
  const timeoutMs = opts?.timeoutMs ?? 6000;

  const log: WebsiteAnalysisLog = {
    rawWebsiteInput: rawInput,
    normalizedUrl: normalized,
    normalizationError,
    fetchAttemptedUrls: [],
    pagesCrawled: 0,
    pagesFetched: 0,
    confidence: 0,
  };

  if (normalizationError || !normalized) {
    log.failureReason = normalizationError === "INVALID_URL" ? "Invalid website URL" : "Could not normalise URL";
    log.errorCode = normalizationError || "INVALID_URL";
    return { pages: [], evidence: emptyEvidence(), log };
  }

  const pages: CrawledPage[] = [];
  const seen = new Set<string>();

  // Try HTTPS first, then fall back to HTTP if the HTTPS fetch fails at the network level.
  let homepage = await fetchPage(normalized, timeoutMs);
  log.fetchAttemptedUrls.push(normalized);

  if (!homepage.fetched && normalized.startsWith("https://")) {
    const httpUrl = normalized.replace(/^https:\/\//, "http://");
    log.fetchAttemptedUrls.push(httpUrl);
    homepage = await fetchPage(httpUrl, timeoutMs);
    if (homepage.fetched) {
      // Continue crawling using the working URL as the base.
      homepage.url = normalized;
    }
  }

  pages.push(homepage);
  seen.add(normalized);

  log.statusCode = homepage.status;
  log.redirectUrl = homepage.redirectUrl;
  log.contentLength = homepage.contentLength;

  if (!homepage.fetched) {
    log.errorCode = homepage.errorCode || "UNKNOWN";
    log.failureReason = homepage.error || "Could not fetch website homepage";
    const evidence = emptyEvidence();
    log.pagesCrawled = pages.length;
    log.pagesFetched = 0;
    log.confidence = evidence.confidence;
    return { pages, evidence, log };
  }

  const candidatePaths = [...KEY_INTERNAL_PATHS];
  for (const link of homepage.links.slice(0, 50)) {
    try {
      const path = new URL(link).pathname.toLowerCase();
      if (candidatePaths.every((p) => !path.startsWith(p))) {
        candidatePaths.push(path);
      }
    } catch {
      // ignore
    }
  }

  for (const path of candidatePaths) {
    if (pages.length >= maxPages) break;
    const resolved = resolveLink(path, normalized);
    if (!resolved || seen.has(resolved)) continue;
    seen.add(resolved);
    log.fetchAttemptedUrls.push(resolved);
    const page = await fetchPage(resolved, timeoutMs);
    pages.push(page);
  }

  const evidence = extractBusinessEvidence(pages);
  log.pagesCrawled = pages.length;
  log.pagesFetched = pages.filter((p) => p.fetched).length;
  log.confidence = evidence.confidence;

  if (evidence.confidence < 0.5) {
    log.failureReason = "No useful business content found";
    log.errorCode = "NO_CONTENT";
  }

  return { pages, evidence, log };
}

function emptyEvidence(): BusinessEvidence {
  return {
    businessCategory: "",
    productsServices: [],
    targetCustomers: [],
    contactDetails: {},
    location: "",
    repeatedKeywords: [],
    evidenceSnippets: [],
    confidence: 0,
    assumptions: ["Could not extract website evidence."],
  };
}

function normaliseWord(word: string): string {
  return word.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function computeRepeatedKeywords(pages: CrawledPage[], topN = 20): RepeatedKeyword[] {
  const counts = new Map<string, number>();
  for (const page of pages) {
    const words = `${page.title} ${page.metaDescription} ${page.ogTitle} ${page.ogDescription} ${page.h1.join(" ")} ${page.h2.join(" ")} ${page.text}`.split(/\s+/);
    for (const word of words) {
      const clean = normaliseWord(word);
      if (clean.length < 3 || STOP_WORDS.has(clean)) continue;
      counts.set(clean, (counts.get(clean) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .filter(([_, c]) => c > 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN)
    .map((entry) => ({ keyword: entry[0], count: entry[1] }));
}

function findBestLocation(pages: CrawledPage[]): string {
  const combined = pages.map((p) => p.text).join(" ");
  const saPlaces = [
    "Johannesburg", "Cape Town", "Durban", "Pretoria", "Port Elizabeth", "Gqeberha",
    "Bloemfontein", "East London", "Sandton", "Rosebank", "Fourways", "Midrand",
    "Centurion", "Randburg", "Soweto", "Pietermaritzburg", "Nelspruit", "Mbombela",
    "Polokwane", "Rustenburg", "Kimberley", "George", "Knysna", "Stellenbosch",
    "Gauteng", "Western Cape", "KwaZulu-Natal", "KZN", "Eastern Cape", "Free State",
    "Mpumalanga", "Limpopo", "North West", "Northern Cape",
  ];
  for (const place of saPlaces) {
    const regex = new RegExp(`\\b${place}\\b`, "i");
    if (regex.test(combined)) return place;
  }
  const addressMatch = combined.match(/\b\d+\s+[A-Za-z0-9\s,'-]{3,40}(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Lane|Ln|Way|Boulevard|Blvd)\b[\s,]*[A-Za-z0-9\s,'-]{0,30}/i);
  if (addressMatch) {
    const candidate = addressMatch[0].trim();
    if (candidate.length < 100 && !/\b(cart|enquire|add to|canvas|poster|art)\b/i.test(candidate)) {
      return candidate;
    }
  }
  return "";
}

function detectBusinessCategory(keywords: RepeatedKeyword[], combinedText: string): { category: string; assumptions: string[] } {
  const text = combinedText.toLowerCase();
  const assumptions: string[] = [];

  // Financial services — checked before loose art/print keywords to avoid misclassification.
  if (
    /\b(financial inclusion|financial services|fintech|payroll|disbursement|wages|earned wage|microfinance|lending|credit|debit|payments|wallet|money transfer|remittance|insurance|investment|wealth management|accounting|bookkeeping|tax services)\b/.test(text)
  ) {
    return { category: "Financial Services / Fintech", assumptions: [] };
  }

  // Art & décor — require explicit multi-word phrases or strong keyword clusters.
  const artDecorPhrases = /\b(canvas art|canvas print|framed poster|wall art|wall decor|home decor|office decor|afrocentric art|custom print|art print|fine art|gallery wall|interior decor|art gallery|canvas printing|poster printing)\b/;
  const artDecorKeywords = ["canvas", "wallart", "framed", "artprint", "fineart", "gallerywall", "interiordecor", "afrocentric"];
  const hasArtDecorPhrase = artDecorPhrases.test(text);
  const hasArtDecorKeywordCluster = artDecorKeywords.filter((w) => keywords.some((k) => k.keyword === w)).length >= 2;
  if (hasArtDecorPhrase || hasArtDecorKeywordCluster) {
    return { category: "Art & Décor / Canvas & Framed Prints", assumptions: [] };
  }

  if (
    /\b(printing|copy|courier|business card|flyer|poster|banner|stationery|laminating|binding)\b/.test(text) ||
    keywords.some((k) => /^(print|copy|courier|flyer|banner|businesscard)$/.test(k.keyword))
  ) {
    return { category: "Print, Copy & Courier Services", assumptions: [] };
  }

  if (/\b(restaurant|cafe|menu|food|takeaway|delivery|coffee|burger|pizza|sushi|catering|bakery)\b/.test(text)) {
    return { category: "Food & Beverage / Restaurant", assumptions: [] };
  }

  if (/\b(salon|barber|hair|nails|beauty|spa|makeup|skincare)\b/.test(text)) {
    return { category: "Beauty & Personal Care", assumptions: [] };
  }

  if (/\b(digital marketing agency|seo agency|social media agency|marketing agency)\b/.test(text)) {
    return { category: "Marketing / Digital Agency", assumptions: [] };
  }

  if (/\b(consulting|consultancy|advisory|coaching|accounting|legal|law firm)\b/.test(text)) {
    return { category: "Professional Services / Consulting", assumptions: ["Category inferred from consulting-related language."] };
  }

  assumptions.push("Could not determine a specific category from the website text; defaulting to general business.");
  return { category: "General Business", assumptions };
}

function detectProductsServices(category: string, pages: CrawledPage[]): { products: string[]; assumptions: string[] } {
  const assumptions: string[] = [];
  const products = new Set<string>();
  const text = pages.map((p) => p.text).join(" ").toLowerCase();
  const headings = pages.flatMap((p) => [...p.h1, ...p.h2, ...p.h3]).join(" ").toLowerCase();

  if (category.includes("Art & Décor")) {
    const artTerms = [
      "Afrocentric canvas art", "custom canvas prints", "framed posters", "wall art",
      "home décor", "office décor", "art prints", "gallery walls", "interior styling",
    ];
    for (const term of artTerms) {
      if (text.includes(term.toLowerCase()) || headings.includes(term.toLowerCase())) products.add(term);
    }
  }

  if (category.includes("Print")) {
    const printTerms = [
      "Printing & copying", "business cards", "flyers", "posters", "banners",
      "branded stationery", "courier services", "document support", "photo prints",
    ];
    for (const term of printTerms) {
      if (text.includes(term.toLowerCase()) || headings.includes(term.toLowerCase())) products.add(term);
    }
  }

  if (products.size === 0) {
    assumptions.push("No explicit product/service list found; inferred from page headings and repeated keywords.");
    pages
      .flatMap((p) => p.h2)
      .filter((h) => h.length > 3 && h.length < 80)
      .slice(0, 6)
      .forEach((h) => products.add(h));
  }

  return { products: [...products], assumptions };
}

function detectTargetCustomers(pages: CrawledPage[]): { customers: string[]; assumptions: string[] } {
  const assumptions: string[] = [];
  const customers = new Set<string>();
  const text = pages.map((p) => p.text).join(" ").toLowerCase();

  const patterns = [
    "homeowners", "interior designers", "businesses", "offices", "hotels",
    "restaurants", "home décor lovers", "art collectors", "small businesses",
    "south african smes", "corporate clients", "retail customers",
  ];
  for (const pattern of patterns) {
    if (text.includes(pattern)) customers.add(pattern);
  }

  if (customers.size === 0) {
    assumptions.push("Target customers not explicitly stated; inferred from product language.");
  }

  return { customers: [...customers], assumptions };
}

function buildEvidenceSnippets(pages: CrawledPage[]): string[] {
  const snippets: string[] = [];
  for (const page of pages) {
    if (page.metaDescription) snippets.push(`[${page.path}] ${page.metaDescription}`);
    for (const h of page.h1.slice(0, 2)) snippets.push(`[${page.path}] ${h}`);
    for (const h of page.h2.slice(0, 3)) snippets.push(`[${page.path}] ${h}`);
  }
  return snippets.slice(0, 20);
}

export function extractBusinessEvidence(pages: CrawledPage[]): BusinessEvidence {
  const fetched = pages.filter((p) => p.fetched);
  const combinedText = fetched.map((p) => p.text).join("\n");
  const allEmails = Array.from(new Set(fetched.flatMap((p) => p.emails)));
  const allPhones = Array.from(new Set(fetched.flatMap((p) => p.phones)));
  const allSocial = Array.from(new Set(fetched.flatMap((p) => p.socialLinks)));

  const { category, assumptions: categoryAssumptions } = detectBusinessCategory(
    computeRepeatedKeywords(fetched),
    combinedText
  );
  const { products, assumptions: productAssumptions } = detectProductsServices(category, fetched);
  const { customers, assumptions: customerAssumptions } = detectTargetCustomers(fetched);

  const location = findBestLocation(fetched);
  const keywords = computeRepeatedKeywords(fetched);

  let confidence = 0;
  if (products.length > 0) confidence += 0.3;
  if (customers.length > 0) confidence += 0.2;
  if (allEmails.length > 0 || allPhones.length > 0) confidence += 0.2;
  if (fetched.length >= 2) confidence += 0.15;
  if (category !== "General Business") confidence += 0.15;
  if (location) confidence += 0.05;
  confidence = Math.min(1, Math.max(0, confidence));

  const assumptions = [
    ...categoryAssumptions,
    ...productAssumptions,
    ...customerAssumptions,
  ];

  return {
    businessCategory: category,
    productsServices: products.length ? products : ["Products/services not clearly listed on the website"],
    targetCustomers: customers.length ? customers : ["Target customers not clearly stated"],
    contactDetails: {
      email: allEmails[0],
      phone: allPhones[0],
      address: location,
      socialLinks: allSocial.slice(0, 5),
    },
    location,
    repeatedKeywords: keywords,
    evidenceSnippets: buildEvidenceSnippets(fetched),
    confidence,
    assumptions,
  };
}

export function buildWebsiteAnalysisPrompt(evidence: BusinessEvidence): string {
  return `Analyse the following structured website evidence and return marketing insights.\n\nBUSINESS EVIDENCE\n- Category: ${evidence.businessCategory}\n- Products/Services Mentioned: ${evidence.productsServices.join(", ")}\n- Target Customers Mentioned: ${evidence.targetCustomers.join(", ")}\n- Location: ${evidence.location || "Not detected"}\n- Repeated Keywords: ${evidence.repeatedKeywords.slice(0, 15).map((k) => `${k.keyword}(${k.count})`).join(", ")}\n- Evidence Snippets:\n${evidence.evidenceSnippets.map((s) => "  - " + s).join("\n")}\n\nCRITICAL RULES:\n1. NEVER classify the business as SEO, digital marketing, social media management, data analytics, restaurant services, salon services, or consulting unless the evidence explicitly and repeatedly supports it.\n2. Only list products/services actually mentioned in the evidence above.\n3. Do not invent contact details, prices, offers, or locations.\n4. If information is missing, make a reasonable assumption and list it.\n\nReturn your analysis in the requested structured format.`;
}

export function isUnsupportedServiceInEvidence(evidence: BusinessEvidence): boolean {
  const combined = `${evidence.businessCategory} ${evidence.productsServices.join(" ")}`.toLowerCase();
  return SERVICE_INVENTION_BLOCKLIST.some((s) => combined.includes(s));
}
