import type { ProgressEvent, ServiceCandidate } from "./types.js";
import { loadConfig } from "./config.js";

export interface BazaarSearchOptions {
  maxBudgetCents?: number;
  limit?: number;
  bazaarUrl?: string;
  fetchImpl?: typeof fetch;
  onProgress?: (event: ProgressEvent) => void;
}

export async function searchServices(query: string, options: BazaarSearchOptions = {}): Promise<ServiceCandidate[]> {
  const config = await loadConfig();
  const baseUrl = options.bazaarUrl ?? config.bazaarUrl;
  const limit = options.limit ?? 10;
  const url = searchUrl(baseUrl);
  if (isCoinbaseBazaarUrl(url)) {
    url.searchParams.set("query", query);
    url.searchParams.set("network", coinbaseNetwork(config.x402PaymentNetwork));
  } else {
    url.searchParams.set("q", query);
  }
  url.searchParams.set("limit", String(limit));
  if (options.maxBudgetCents !== undefined) {
    if (isCoinbaseBazaarUrl(url)) {
      url.searchParams.set("maxUsdPrice", (options.maxBudgetCents / 100).toFixed(2));
    } else {
      url.searchParams.set("max_budget_cents", String(options.maxBudgetCents));
    }
  }
  options.onProgress?.({ type: "searching", message: `Searching Bazaar for "${query}"` });
  const response = await fetchWithRetry(options.fetchImpl ?? fetch, url);
  if (!response.ok) {
    throw new Error(`Bazaar search failed: ${response.status} ${response.statusText}`);
  }
  const body = await response.json();
  options.onProgress?.({ type: "ranking", message: "Ranking service candidates" });
  return normalizeBazaarResponse(body)
    .filter((candidate) => options.maxBudgetCents === undefined || candidate.price_cents === undefined || candidate.price_cents <= options.maxBudgetCents)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

async function fetchWithRetry(fetchImpl: typeof fetch, url: URL): Promise<Response> {
  let lastResponse: Response | undefined;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(url);
      if (response.ok || !isRetryableStatus(response.status) || attempt === 2) {
        return response;
      }
      lastResponse = response;
    } catch (error) {
      lastError = error;
      if (attempt === 2) {
        throw error;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250 * (attempt + 1)));
  }
  if (lastResponse) {
    return lastResponse;
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function normalizeBazaarResponse(body: unknown): ServiceCandidate[] {
  const records = Array.isArray(body)
    ? body
    : Array.isArray((body as { resources?: unknown[] }).resources)
      ? (body as { resources: unknown[] }).resources
    : Array.isArray((body as { services?: unknown[] }).services)
      ? (body as { services: unknown[] }).services
      : Array.isArray((body as { results?: unknown[] }).results)
        ? (body as { results: unknown[] }).results
        : Array.isArray((body as { items?: unknown[] }).items)
          ? (body as { items: unknown[] }).items
          : Array.isArray((body as { data?: unknown[] }).data)
            ? (body as { data: unknown[] }).data
            : [];

  return records.flatMap((record, index) => normalizeRecord(record, index));
}

function normalizeRecord(record: unknown, index: number): ServiceCandidate[] {
  if (!record || typeof record !== "object") {
    return [];
  }
  const item = record as Record<string, unknown>;
  if (Array.isArray(item.accepts)) {
    return normalizeCoinbaseResource(item, index);
  }
  if (Array.isArray(item.endpoints)) {
    return item.endpoints.flatMap((endpoint, endpointIndex) => normalizeEndpoint(item, endpoint, index, endpointIndex));
  }
  const resourceUrl = stringValue(item.resource_url ?? item.resourceUrl ?? item.url ?? item.endpoint);
  if (!resourceUrl) {
    return [];
  }
  const rawMethods = item.methods ?? item.method ?? item.http_methods;
  const methods = Array.isArray(rawMethods) ? rawMethods.map(String) : rawMethods ? [String(rawMethods)] : ["POST"];
  const rawTags = item.tags ?? item.categories;
  const tags = Array.isArray(rawTags) ? rawTags.map(String) : [];
  const price = numberValue(item.price_cents ?? item.cost_cents ?? item.priceCents ?? item.minimum_cost_cents);
  return [{
    resource_url: resourceUrl,
    title: stringValue(item.title ?? item.name),
    description: stringValue(item.description ?? item.summary),
    methods,
    price_cents: price,
    price_display: price === undefined ? undefined : formatCentPrice(price, stringValue(item.currency) ?? "USD"),
    currency: stringValue(item.currency) ?? "USD",
    tags,
    score: numberValue(item.score ?? item.rank) ?? 1 / (index + 1),
    raw: record
  }];
}

function normalizeCoinbaseResource(item: Record<string, unknown>, index: number): ServiceCandidate[] {
  const accepts = item.accepts as unknown[];
  const requirement = selectCoinbaseRequirement(accepts);
  const resourceUrl =
    resourceUrlFromRequirement(requirement) ??
    stringValue(item.resource ?? item.resource_url ?? item.resourceUrl ?? item.url ?? item.endpoint);
  if (!resourceUrl) {
    return [];
  }
  const price = priceFromCoinbaseRequirement(requirement);
  return [{
    resource_url: resourceUrl,
    title: stringValue(item.serviceName ?? item.name ?? item.title) ?? hostFromUrl(resourceUrl),
    description: stringValue(item.description ?? descriptionFromRequirement(requirement)),
    methods: methodsFromCoinbaseResource(item),
    price_cents: price?.cents,
    price_display: price?.display,
    currency: price?.currency ?? "USDC",
    tags: Array.isArray(item.tags) ? item.tags.map(String) : [],
    score: numberValue(item.score ?? item.rank) ?? 1 / (index + 1),
    raw: item
  }];
}

function normalizeEndpoint(service: Record<string, unknown>, endpoint: unknown, serviceIndex: number, endpointIndex: number): ServiceCandidate[] {
  if (!endpoint || typeof endpoint !== "object") {
    return [];
  }
  const item = endpoint as Record<string, unknown>;
  const resourceUrl = stringValue(item.url ?? item.resource_url ?? item.endpoint);
  if (!resourceUrl) {
    return [];
  }
  const pricing = item.pricing && typeof item.pricing === "object" ? item.pricing as Record<string, unknown> : {};
  const amount = exactNumberValue(pricing.amount);
  const currency = stringValue(pricing.currency) ?? "USDC";
  return [{
    resource_url: resourceUrl,
    title: [stringValue(service.name), stringValue(item.providerName), stringValue(item.description)].filter(Boolean).join(" - "),
    description: stringValue(item.description ?? service.description),
    methods: [String(item.method ?? "POST")],
    price_cents: amount === undefined ? undefined : Math.max(1, Math.ceil(amount * 100)),
    price_display: amount === undefined ? undefined : `${trimNumber(amount)} ${currency}`,
    currency,
    tags: [stringValue(service.category), ...(Array.isArray(service.tags) ? service.tags.map(String) : [])].filter((tag): tag is string => Boolean(tag)),
    score: 1 / (serviceIndex + endpointIndex + 1),
    raw: { service, endpoint }
  }];
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.round(value);
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Math.round(Number(value));
  }
  return undefined;
}

function exactNumberValue(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return undefined;
}

function selectCoinbaseRequirement(accepts: unknown[]): Record<string, unknown> | undefined {
  const records = accepts.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item));
  return records.find((item) => item.network === "eip155:8453" && item.scheme === "exact")
    ?? records.find((item) => item.network === "eip155:8453")
    ?? records[0];
}

function resourceUrlFromRequirement(requirement: Record<string, unknown> | undefined): string | undefined {
  const resource = requirement?.resource;
  if (resource && typeof resource === "object" && !Array.isArray(resource)) {
    return stringValue((resource as Record<string, unknown>).url);
  }
  return undefined;
}

function descriptionFromRequirement(requirement: Record<string, unknown> | undefined): string | undefined {
  return stringValue(requirement?.description);
}

function priceFromCoinbaseRequirement(requirement: Record<string, unknown> | undefined): { cents: number; display: string; currency: string } | undefined {
  if (!requirement) {
    return undefined;
  }
  const amount = exactNumberValue(requirement.amount);
  if (amount === undefined) {
    return undefined;
  }
  const currency = coinbaseCurrency(requirement);
  const decimalAmount = coinbaseDecimalAmount(amount, currency);
  return {
    cents: Math.max(1, Math.ceil(decimalAmount * 100)),
    display: `${trimNumber(decimalAmount)} ${currency}`,
    currency
  };
}

function coinbaseCurrency(requirement: Record<string, unknown>): string {
  const extra = requirement.extra;
  if (extra && typeof extra === "object" && !Array.isArray(extra)) {
    const name = stringValue((extra as Record<string, unknown>).name);
    if (name === "USD Coin") {
      return "USDC";
    }
  }
  const asset = stringValue(requirement.asset);
  if (asset === "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913") {
    return "USDC";
  }
  return asset ?? "USDC";
}

function coinbaseDecimalAmount(amount: number, currency: string): number {
  if (currency === "USDC" && Number.isInteger(amount) && amount >= 1_000) {
    return amount / 1_000_000;
  }
  return amount;
}

function methodsFromCoinbaseResource(item: Record<string, unknown>): string[] {
  const bazaar = nestedRecord(item, ["extensions", "bazaar"]);
  const infoInput = nestedRecord(item, ["extensions", "bazaar", "info", "input"]);
  const method = stringValue(infoInput?.method);
  if (method) {
    return [method];
  }
  const schemaMethod = nestedRecord(bazaar ?? {}, ["schema", "properties", "input", "properties", "method"]);
  if (Array.isArray(schemaMethod?.enum)) {
    return schemaMethod.enum.map(String);
  }
  return ["GET"];
}

function nestedRecord(root: Record<string, unknown>, path: string[]): Record<string, unknown> | undefined {
  let current: unknown = root;
  for (const key of path) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current && typeof current === "object" && !Array.isArray(current) ? current as Record<string, unknown> : undefined;
}

function formatCentPrice(cents: number, currency: string): string {
  if (currency.toUpperCase() === "USD") {
    return `$${(cents / 100).toFixed(2)}`;
  }
  return `${trimNumber(cents / 100)} ${currency}`;
}

function trimNumber(value: number): string {
  return value.toLocaleString("en-US", {
    maximumFractionDigits: 8,
    useGrouping: false
  });
}

function hostFromUrl(value: string): string {
  try {
    return new URL(value).host;
  } catch {
    return value;
  }
}

function searchUrl(baseUrl: string): URL {
  const normalized = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  if (normalized.includes("/x402/discovery/search")) {
    return new URL(baseUrl);
  }
  if (normalized.endsWith("/x402/discovery/resources/")) {
    return new URL("search", normalized.replace(/resources\/$/, ""));
  }
  if (normalized.endsWith("/v1/services/")) {
    return new URL("search", normalized);
  }
  return new URL("api/search", normalized);
}

function isCoinbaseBazaarUrl(url: URL): boolean {
  return url.hostname === "api.cdp.coinbase.com" && url.pathname.includes("/x402/discovery/search");
}

function coinbaseNetwork(network: string): string {
  return network === "base" ? "eip155:8453" : network;
}
