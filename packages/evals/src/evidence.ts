import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * CrowdCode evidence export. Pulls every service's score, effective review
 * count, nightly digest, and raw recent reviews (reason + task context) from
 * the public CrowdCode API and flattens them into itemized evidence entries
 * with stable IDs. The knowledge-tree proposer cites these IDs, which lets
 * the validator reject claims that reference no evidence.
 */

export interface ServiceEvidence {
  service_id: string;
  name: string;
  endpoint: string;
  origin: string;
  payment_provider: string;
  score: number;
  n_eff: number;
  unproven: boolean;
  num_reviews: number;
  num_verified_reviews: number;
  histogram?: Record<string, number>;
  summary?: { strengths?: string[]; failure_modes?: string[]; caveats?: string[] };
  reviews: ReviewEvidence[];
}

export interface ReviewEvidence {
  /** Stable id: <service_id>#r<n> */
  id: string;
  rating: number;
  reason: string;
  task_context?: string;
  verified: boolean;
  created_at?: string;
}

export interface EvidenceBundle {
  fetched_at: string;
  source: string;
  services: ServiceEvidence[];
  stats: { services: number; reviews: number; services_with_reviews: number };
}

export interface FetchEvidenceOptions {
  baseUrl?: string;
  /**
   * Bearer token for the gated full export (GET /api/knowledge/evidence,
   * every review per service). Defaults to CROWDCODE_KNOWLEDGE_EXPORT_TOKEN;
   * without it the public per-service view (5 most recent reviews) is used.
   */
  exportToken?: string;
  cachePath?: string;
  /** Reuse the cache if it exists (default true). */
  useCache?: boolean;
  fetchImpl?: typeof fetch;
  concurrency?: number;
  log?: (message: string) => void;
}

const DEFAULT_BASE_URL = "https://crowdcode-backend.onrender.com";

export async function fetchCrowdCodeEvidence(options: FetchEvidenceOptions = {}): Promise<EvidenceBundle> {
  const cachePath = options.cachePath;
  if (cachePath && options.useCache !== false) {
    try {
      return JSON.parse(await readFile(cachePath, "utf8")) as EvidenceBundle;
    } catch {
      // fall through to network
    }
  }
  const baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const log = options.log ?? (() => undefined);
  const exportToken = options.exportToken ?? process.env.CROWDCODE_KNOWLEDGE_EXPORT_TOKEN;
  if (exportToken) {
    const exported = await fetchGatedExport(fetchImpl, baseUrl, exportToken, log);
    if (exported) {
      if (cachePath) {
        await mkdir(dirname(cachePath), { recursive: true });
        await writeFile(cachePath, `${JSON.stringify(exported, null, 1)}\n`, "utf8");
      }
      return exported;
    }
    log("gated evidence export unavailable; falling back to the public per-service view");
  }
  log(`fetching ${baseUrl}/api/services`);
  const listing = await (await fetchImpl(`${baseUrl}/api/services`)).json() as { services?: Array<Record<string, unknown>> };
  const ids = (listing.services ?? []).map((service) => String(service.service_id));
  const services: ServiceEvidence[] = [];
  const limit = createLimiter(options.concurrency ?? 8);
  await Promise.all(ids.map((id) => limit(async () => {
    const detail = await fetchWithRetry(fetchImpl, `${baseUrl}/api/services/${id}`);
    if (detail) {
      services.push(flattenService(detail));
    }
  })));
  services.sort((left, right) => right.n_eff * right.score - left.n_eff * left.score || right.num_reviews - left.num_reviews);
  const bundle: EvidenceBundle = {
    fetched_at: new Date().toISOString(),
    source: baseUrl,
    services,
    stats: {
      services: services.length,
      reviews: services.reduce((sum, service) => sum + service.num_reviews, 0),
      services_with_reviews: services.filter((service) => service.num_reviews > 0).length
    }
  };
  if (cachePath) {
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, `${JSON.stringify(bundle, null, 1)}\n`, "utf8");
  }
  return bundle;
}

async function fetchGatedExport(
  fetchImpl: typeof fetch,
  baseUrl: string,
  token: string,
  log: (message: string) => void
): Promise<EvidenceBundle | undefined> {
  const url = `${baseUrl}/api/knowledge/evidence?max_reviews=100`;
  log(`fetching ${url}`);
  try {
    const response = await fetchImpl(url, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000) });
    if (!response.ok) {
      log(`gated export returned ${response.status}`);
      return undefined;
    }
    const body = await response.json() as { services?: Array<Record<string, unknown>> };
    const services = (body.services ?? []).map((raw) => flattenService({
      service: raw,
      score: raw.score,
      n_eff: raw.n_eff,
      unproven: raw.unproven,
      num_reviews: raw.num_reviews,
      num_verified_reviews: raw.num_verified_reviews,
      summary: raw.summary,
      recent_reviews: raw.reviews
    }));
    services.sort((left, right) => right.n_eff * right.score - left.n_eff * left.score || right.num_reviews - left.num_reviews);
    return {
      fetched_at: new Date().toISOString(),
      source: `${baseUrl} (gated full export)`,
      services,
      stats: {
        services: services.length,
        reviews: services.reduce((sum, service) => sum + service.num_reviews, 0),
        services_with_reviews: services.filter((service) => service.num_reviews > 0).length
      }
    };
  } catch (error) {
    log(`gated export failed: ${(error as Error).message}`);
    return undefined;
  }
}

export function flattenService(detail: Record<string, unknown>): ServiceEvidence {
  const service = asRecord(detail.service);
  const endpoint = String(service.canonical_endpoint ?? "");
  const summary = asRecord(detail.summary);
  const serviceId = String(service.service_id ?? "");
  const reviews = (Array.isArray(detail.recent_reviews) ? detail.recent_reviews : []).map((raw, index) => {
    const review = asRecord(raw);
    return {
      id: `${serviceId}#r${index + 1}`,
      rating: Number(review.rating ?? 0),
      reason: String(review.reason ?? ""),
      task_context: typeof review.task_context === "string" && review.task_context.length > 0 ? review.task_context : undefined,
      verified: review.payment_verified === true,
      created_at: typeof review.created_at === "string" ? review.created_at : undefined
    };
  });
  return {
    service_id: serviceId,
    name: String(service.name ?? ""),
    endpoint,
    origin: originOf(endpoint),
    payment_provider: String(service.payment_provider ?? "unknown"),
    score: Number(detail.score ?? 0),
    n_eff: Number(detail.n_eff ?? 0),
    unproven: detail.unproven === true,
    num_reviews: Number(detail.num_reviews ?? 0),
    num_verified_reviews: Number(detail.num_verified_reviews ?? 0),
    histogram: detail.histogram as Record<string, number> | undefined,
    summary: Object.keys(summary).length > 0
      ? {
        strengths: stringList(summary.strengths),
        failure_modes: stringList(summary.failure_modes),
        caveats: stringList(summary.caveats)
      }
      : undefined,
    reviews
  };
}

/**
 * Compact, deterministic text rendering of the evidence for the proposer.
 * Services are ordered by evidence weight (score x n_eff); the proposer
 * sees raw review reasons, not just the aggregate.
 */
export function renderEvidenceDigest(
  bundle: EvidenceBundle,
  options: { maxServices?: number; maxReviewsPerService?: number; detailTop?: number } = {}
): string {
  const maxServices = options.maxServices ?? bundle.services.length;
  const maxReviews = options.maxReviewsPerService ?? 5;
  /** Only the top-N services (by evidence weight) get digests and raw reviews; the rest are one-liners. */
  const detailTop = options.detailTop ?? bundle.services.length;
  const lines: string[] = [
    `CrowdCode evidence snapshot ${bundle.fetched_at}: ${bundle.stats.services} services, ${bundle.stats.reviews} reviews.`,
    "Each service: [service_id] name | endpoint | rail | score/5 (n_eff, reviews, verified) | unproven?",
    ""
  ];
  for (const [index, service] of bundle.services.slice(0, maxServices).entries()) {
    const detailed = index < detailTop;
    lines.push(`[${service.service_id}] ${service.name} | ${service.endpoint} | ${service.payment_provider} | ${service.score.toFixed(2)} (n_eff ${service.n_eff.toFixed(1)}, ${service.num_reviews} reviews, ${service.num_verified_reviews} verified)${service.unproven ? " | UNPROVEN" : ""}`);
    if (!detailed) {
      continue;
    }
    if (service.summary) {
      if (service.summary.strengths?.length) {
        lines.push(`  strengths: ${service.summary.strengths.join(" / ")}`);
      }
      if (service.summary.failure_modes?.length) {
        lines.push(`  failure modes: ${service.summary.failure_modes.join(" / ")}`);
      }
      if (service.summary.caveats?.length) {
        lines.push(`  caveats: ${service.summary.caveats.join(" / ")}`);
      }
    }
    for (const review of service.reviews.slice(0, maxReviews)) {
      lines.push(`  ${review.id} ${review.rating}/5${review.verified ? " verified" : ""}: ${compact(review.reason, 260)}${review.task_context ? ` [task: ${compact(review.task_context, 120)}]` : ""}`);
    }
  }
  return lines.join("\n");
}

async function fetchWithRetry(fetchImpl: typeof fetch, url: string): Promise<Record<string, unknown> | undefined> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) });
      if (response.ok) {
        return await response.json() as Record<string, unknown>;
      }
    } catch {
      // retry
    }
    await new Promise((resolve) => setTimeout(resolve, 1500 * (attempt + 1)));
  }
  return undefined;
}

function originOf(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return endpoint;
  }
}

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map((item) => String(item)) : undefined;
}

function compact(value: string, maxLength: number): string {
  const single = value.replace(/\s+/g, " ").trim();
  return single.length <= maxLength ? single : `${single.slice(0, maxLength - 1)}…`;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function createLimiter(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    active -= 1;
    queue.shift()?.();
  };
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active += 1;
    try {
      return await fn();
    } finally {
      next();
    }
  };
}
