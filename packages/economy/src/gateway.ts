import { CrowdCodePreferences } from "./crowdcode-preferences.js";
import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { extractMedia } from "./media.js";
import { capStrings, MAX_EXTERNAL_STRING_CHARS } from "@opencrowd/protocol";
import {
  appendLedgerEntry, SpendingApprovalRequired, SpendingDeclined,
  finalizeReservation,
  releaseReservation,
  reserveBudget,
  saveArtifact,
  type ProgressEvent,
  type SessionState,
  type ToolResult
} from "@opencrowd/core";
import type { AgentCashAdapter, PaidFetchResult, PaymentRail } from "./agentcash.js";
import type { CrowdCodeAdapter, ServiceEvidence } from "./crowdcode.js";
import { describeRails } from "./offers.js";
import { PROBE } from "./discovery.js";
import { routeTemplate } from "./route.js";
import { reliabilityNote, type CrowdCodeApi, type Reliability } from "./tree.js";
import { documentedHeader, findFollowUpTokens, followUpKey, loadFollowUps, saveFollowUp, sellerOpenApi } from "./follow-ups.js";
import {
  loadApprovalRules,
  matchApprovalRule,
  upsertApprovalRule,
  type ApprovalHandler,
  type ApprovalMode
} from "./approvals.js";
import {
  appendPurchase,
  listPurchases,
  newPurchaseId,
  recordReviewSubmitted, recordReviewFailed,
  redactPurchase,
  type PurchaseOutcome,
  type PurchaseRecord
} from "./purchases.js";

/**
 * The enforced paid-capability state machine. The model sees only the six
 * stable gateway tools; every potentially paid call runs the full lifecycle
 * in code regardless of what the model asked for:
 *
 *   find/discover -> inspect -> CrowdCode pre-check -> approval ->
 *   budget reservation -> AgentCash execution -> outcome reconciliation ->
 *   artifact + immutable receipt -> finalize/release -> audit entry
 *
 * No review step: on hosted agents CrowdCode's gateway judges every settled
 * purchase on its own, and `review_paid_service` is optional notes.
 */

export const GATEWAY_TOOL_NAMES = [
  "crowdcode_status", "set_crowdcode_enabled", "request_service", "list_my_reviews", "delete_my_review",
  "read_service",
  "get_wallet_status",
  "browse_services",
  "find_paid_service",
  "inspect_paid_service",
  "call_paid_service",
  "review_paid_service",
  "bridge_usdc"
] as const;

export type GatewayToolName = typeof GATEWAY_TOOL_NAMES[number];

export interface GatewayToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

interface Inspection {
  endpoint: string;
  method: string;
  rail: PaymentRail;
  priceCeilingCents?: number;
  /** Payee of the inspected offer, for reviews whose receipt omits it. */
  payTo?: string;
  /** A registered collect step's: the purpose its submit was called for. */
  purpose?: string;
  /** This is an async job's collect step: calling it waits for the job (w107 phase 2). */
  collect?: boolean;
  evidence: ServiceEvidence;
  inspectedAt: string;
}

export interface EconomyGatewayOptions {
  session: SessionState;
  agentcash: AgentCashAdapter;
  crowdcode: CrowdCodeAdapter;
  approvalMode: ApprovalMode;
  /** Hosted gateway owns the actual quote, spending policy and reservations. */
  hostedSpending?: boolean;
  /** Human decision point for ask-mode; absent means un-ruled services are denied. */
  approvalHandler?: ApprovalHandler;
  /** Stored allow/block rules location (defaults to the user config dir). */
  approvalRulesPath?: string;
  /** Reject services with sufficient evidence below this score (default 2). */
  minServiceScore?: number;
  /** Rails this payer may settle automatically (default VERIFIED_RAILS). */
  paymentRails?: readonly PaymentRail[];
  /**
   * CrowdCode's capability tree and reliability states (C7, C3). Absent, as
   * in tests and offline runs, browse_services says so and search results
   * carry no reliability.
   */
  crowdcodeApi?: CrowdCodeApi;
  onProgress?: (event: ProgressEvent) => void;
}

/** Rails CrowdCode verifies end to end: x402 on Base, Solana and Monad, and MPP on Tempo. */
export const VERIFIED_RAILS: readonly PaymentRail[] = ["x402-base", "x402-solana", "x402-monad", "mppx"];

/**
 * Review rejections that are facts about the directory, not about the attempt.
 *
 * CrowdCode resolves a review against the services it already has registered.
 * When the identity it is given matches more than one of them, or matches none,
 * it says so — and will say the same thing to the identical submission a minute
 * later. Everything else (a transport failure, a 5xx, a rate limit) is worth
 * another go.
 */
const PERMANENT_REVIEW_REJECTION =
  /service identity conflict|payment target is shared by multiple services|service not found|unknown purchase/i;
export const isPermanentReviewRejection = (error: string | undefined) =>
  !!error && PERMANENT_REVIEW_REJECTION.test(error);

export class EconomyGateway {
  /**
   * Inspections are keyed by endpoint+method and persisted under the session so
   * a run resumed on a fresh gateway instance (funds pause, worker restart) still
   * honours the inspect-before-call rule instead of failing its first call.
   */
  private inspections?: Map<string, Inspection>;

  /**
   * Endpoints (method and route template) this run has reviewed: an agent
   * reviews an endpoint at most once per run, however many calls it made
   * to it (SRI-135). Six clips from one video model are one review.
   */
  private readonly reviewedEndpoints = new Set<string>();

  constructor(private readonly options: EconomyGatewayOptions) {}

  private get inspectionsPath(): string {
    return join(this.options.session.sessionDir, "inspections.json");
  }

  private async loadInspections(): Promise<Map<string, Inspection>> {
    if (this.inspections) return this.inspections;
    const map = new Map<string, Inspection>();
    try {
      const stored = JSON.parse(await readFile(this.inspectionsPath, "utf8")) as Record<string, Inspection>;
      for (const [key, value] of Object.entries(stored)) map.set(key, value);
    } catch {
      /* No inspections stored yet, or an unreadable file: the model must inspect again. */
    }
    this.inspections = map;
    return map;
  }

  private async rememberInspection(key: string, inspection: Inspection): Promise<void> {
    await this.rememberInspections([[key, inspection]]);
  }

  private async rememberInspections(entries: [string, Inspection][]): Promise<void> {
    const map = await this.loadInspections();
    for (const [key, inspection] of entries) map.set(key, inspection);
    await writeFile(this.inspectionsPath, JSON.stringify(Object.fromEntries(map)), "utf8");
  }

  definitions(): GatewayToolDefinition[] {
    return GATEWAY_TOOL_DEFINITIONS;
  }

  hasTool(name: string): boolean {
    return (GATEWAY_TOOL_NAMES as readonly string[]).includes(name);
  }

  async execute(name: string, args: Record<string, unknown>, operationId?: string): Promise<ToolResult> {
    try {
      switch (name as GatewayToolName) {
        case "crowdcode_status":
        case "set_crowdcode_enabled":
        case "request_service":
        case "list_my_reviews":
        case "delete_my_review":
          return await this.manageCrowdCode(name, args);
        case "get_wallet_status":
          return await this.getWalletStatus();
        case "browse_services":
          return await this.browseServices(args);
        case "find_paid_service":
          return await this.findPaidService(args);
        case "inspect_paid_service":
          return await this.inspectPaidService(args);
        case "call_paid_service":
          return await this.callAndCollect(args, operationId);
        case "review_paid_service":
          return await this.reviewPaidService(args);
        case "read_service":
          return await this.readService(args);
        case "bridge_usdc":
          return await this.bridgeUsdc(args, operationId);
        default:
          return { ok: false, error: `unknown gateway tool: ${name}` };
      }
    } catch (error) {
      if (error instanceof SpendingApprovalRequired || error instanceof SpendingDeclined || (error as Error).name === "RuntimePause") throw error;
      return { ok: false, error: (error as Error).message };
    }
  }

  private async crowdcodeEnabled(): Promise<boolean> {
    if (!this.options.hostedSpending && !this.options.crowdcode.manage) return true;
    const status = await this.manageCrowdCode("crowdcode_status", {});
    if (!status.ok) throw new Error(status.error ?? "CrowdCode preferences unavailable");
    return (status.data as { enabled?: boolean })?.enabled === true;
  }

  private async manageCrowdCode(name: string, args: Record<string, unknown>): Promise<ToolResult> {
    // Without `enabled` it is a read: the one model-facing tool for the setting.
    if (name === "set_crowdcode_enabled" && args.enabled === undefined) return this.manageCrowdCode("crowdcode_status", {});
    if (name === "set_crowdcode_enabled") {
      if (typeof args.enabled !== "boolean" || (args.scope !== undefined && args.scope !== "session" && args.scope !== "default"))
        return { ok: false, error: "Provide enabled (boolean) and scope (session or default)" };
    }
    if (this.options.hostedSpending && (name === "crowdcode_status" || name === "set_crowdcode_enabled")) {
      const preferences = new CrowdCodePreferences(this.options.session);
      const data = name === "crowdcode_status" ? await preferences.status() : await preferences.set(args.enabled as boolean, (args.scope ?? "session") as "session" | "default");
      return { ok: true, data };
    }
    if (name === "request_service" && !(await this.crowdcodeEnabled())) return { ok: false, error: "CrowdCode is off. Turn it on to submit service requests." };
    if (!this.options.crowdcode.manage) return { ok: false, error: "CrowdCode management is unavailable" };
    return await this.options.crowdcode.manage(name, args);
  }

  private async serviceEvidence(endpoint: string): Promise<ServiceEvidence> {
    return await this.crowdcodeEnabled() ? this.options.crowdcode.getServiceScore({ apiEndpoint: endpoint })
      : { ok: true, unproven: true, summary: "CrowdCode is off; reputation checks and submissions are disabled." };
  }

  /** An unpaid read is still an external body: bound it like a paid one. */
  private async readService(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.options.agentcash.read) return { ok: false, error: "Authenticated reads are unavailable" };
    const result = await this.options.agentcash.read(String(args.url ?? ""));
    if (!result.ok || result.data === undefined) return result as ToolResult;
    return { ...result, data: await boundResponse(this.options.session, result.data) } as ToolResult;
  }

  private async getWalletStatus(): Promise<ToolResult> {
    const result = await this.options.agentcash.getBalance();
    if (!result.ok) {
      return { ok: false, error: result.error ?? "wallet status unavailable" };
    }
    return { ok: true, data: result.data };
  }

  private async findPaidService(args: Record<string, unknown>): Promise<ToolResult> {
    const origin = stringArg(args.origin);
    const task = stringArg(args.task)?.replace(/\s+/g, " ").slice(0, TASK_MAX_CHARS);
    // A task alone still needs a query for AgentCash's catalog (and for a CrowdCode that predates tasks).
    const query = stringArg(args.query) ?? (task ? task.slice(0, 200) : undefined);
    if (origin) {
      const result = await this.options.agentcash.discoverEndpoints(origin);
      return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error };
    }
    if (query) {
      // CrowdCode ranks across chains when it is on; off, or on an older adapter, AgentCash's order stands.
      const findServices = this.options.crowdcode.findServices?.bind(this.options.crowdcode);
      const rank = findServices && await this.crowdcodeEnabled().catch(() => false) ? findServices : undefined;
      // Six ranked results carry their reliability within about 800 tokens; the agent can ask for more.
      const result = await this.options.agentcash.search(query, { limit: intArg(args.limit) ?? (rank && this.options.crowdcodeApi ? SEARCH_LIMIT : undefined), ...(rank ? { rank } : {}), ...(task && rank ? { task } : {}) });
      if (!result.ok) return { ok: false, error: result.error };
      // Read the probes before compaction copies the rows (a spread drops them).
      const probes = probesOf(result.data);
      return { ok: true, data: await this.adoptProbed(rank ? await this.withReliability(result.data) : result.data, probes) };
    }
    return { ok: false, error: "find_paid_service requires `task` (the need in a sentence), `query` (capability search) or `origin` (known origin)" };
  }

  /**
   * Search already probed every result it returns, exactly as
   * inspect_paid_service would (w107 phase 0). Record each probe as that
   * endpoint's inspection and show its input fields and answer shape, so the
   * agent goes from a search straight to call_paid_service: one model turn
   * instead of two. The reputation floor is still checked when it pays, as for
   * any call; only results the search kept (none `bad` or unreliable) are
   * recorded.
   */
  private async adoptProbed(data: unknown, probes: Map<string, Record<string, unknown>>): Promise<unknown> {
    const services = (data as { services?: unknown } | undefined)?.services;
    if (!probes.size || !Array.isArray(services)) return data;
    const inspectedAt = new Date().toISOString();
    const recorded: [string, Inspection][] = [];
    const shown = services.map((service) => {
      const row = service as Record<string, unknown>;
      const probe = typeof row.endpoint === "string" ? probes.get(row.endpoint) : undefined;
      if (!probe || typeof row.endpoint !== "string") return service;
      const method = String(row.method ?? probe.method ?? "POST").toUpperCase();
      const free = probe.free === true;
      recorded.push([inspectionKey(row.endpoint, method), {
        endpoint: row.endpoint, method, rail: railFromSchema(probe),
        priceCeilingCents: free ? 0 : priceCeilingFromSchema(probe),
        ...(typeof probe.pay_to === "string" ? { payTo: probe.pay_to } : {}),
        evidence: { ok: true, unproven: true, summary: "probed by find_paid_service; reputation is checked when it is paid" },
        inspectedAt
      }]);
      const input = describeInput(probe.input_schema);
      const output = describeOutput(probe.output_schema);
      return { ...row, ...(input ? { input } : {}), ...(output ? { returns: output } : {}), ...(free ? { free: true } : {}), inspected: true };
    });
    if (recorded.length) await this.rememberInspections(recorded);
    return { ...(data as Record<string, unknown>), services: shown };
  }

  /** One node of the capability tree, at the version this session's instructions were built from. */
  private async browseServices(args: Record<string, unknown>): Promise<ToolResult> {
    if (!this.options.crowdcodeApi) return { ok: false, error: "The capability tree is unavailable in this run; use find_paid_service." };
    return this.options.crowdcodeApi.browse(args.node, this.options.session.knowledge?.tree);
  }

  /** C3's state for one endpoint, when CrowdCode is on and can say. */
  private async reliabilityOf(endpoint: string, method: string): Promise<Reliability | undefined> {
    if (!this.options.crowdcodeApi || !(await this.crowdcodeEnabled().catch(() => false))) return undefined;
    return this.options.crowdcodeApi.reliability(endpoint, method).catch(() => undefined);
  }

  /**
   * Each ranked result with its reliability state and first reason, reliable
   * first and unreliable last, keeping CrowdCode's order within a state: the
   * agent knows before paying whether the owner will be asked (C4).
   */
  private async withReliability(data: unknown): Promise<unknown> {
    const services = (data as { services?: unknown } | undefined)?.services;
    if (!this.options.crowdcodeApi || !Array.isArray(services) || !services.length) return data;
    // CrowdCode's index search already carries each result's tier and why (C13): no lookups needed.
    if (services.every((service) => typeof (service as { tier?: unknown }).tier === "string")) {
      const rows = services as Record<string, unknown>[];
      const refused = rows.filter((row) => row.tier === "bad").map((row) => row.endpoint);
      return { services: rows.filter((row) => row.tier !== "bad").map((row) => compactService(row, undefined)),
        ...(refused.length ? { bad_left_out: refused } : {}), note: `${TIER_NOTE} ${COMPACT_RANKED_NOTE}${incompleteNote(data)}` };
    }
    const states = await Promise.all(services.map((service) => {
      const row = service as { endpoint?: unknown; method?: unknown };
      return typeof row.endpoint === "string" ? this.reliabilityOf(row.endpoint, typeof row.method === "string" ? row.method : "POST") : undefined;
    }));
    if (!states.some(Boolean)) return data;
    const rows = services.map((service, index) => ({ service: service as Record<string, unknown>, index, reliability: states[index] }));
    // Unreliable is refused before payment: name it once instead of listing it.
    const refused = rows.filter((row) => row.reliability?.state === "unreliable").map((row) => row.service.endpoint);
    const annotated = rows.filter((row) => row.reliability?.state !== "unreliable")
      .sort((a, b) => Number(b.reliability?.state === "reliable") - Number(a.reliability?.state === "reliable") || a.index - b.index)
      .map(({ service, reliability }) => compactService(service, reliability));
    return { services: annotated, ...(refused.length ? { unreliable_left_out: refused } : {}),
      note: `${RELIABILITY_NOTE} ${COMPACT_RANKED_NOTE}${incompleteNote(data)}` };
  }

  private async inspectPaidService(args: Record<string, unknown>): Promise<ToolResult> {
    const endpoint = stringArg(args.url);
    if (!endpoint) {
      return { ok: false, error: "inspect_paid_service requires `url`" };
    }
    const malformedInspect = endpointProblem(endpoint);
    if (malformedInspect) return { ok: false, error: malformedInspect };
    const method = (stringArg(args.method) ?? "POST").toUpperCase();
    const schema = await this.options.agentcash.checkEndpointSchema({
      url: endpoint,
      method,
      body: args.sample_body
    });
    if (!schema.ok) {
      return { ok: false, error: schema.error };
    }
    const [evidence, reliability] = await Promise.all([this.serviceEvidence(endpoint), this.reliabilityOf(endpoint, method)]);
    const rail = railFromSchema(schema.data);
    // Free but signed: its ceiling is nothing. Should the seller price it by
    // the time it is called, the gateway sees a quote above the ceiling and
    // asks the owner instead of paying.
    const free = (schema.data as { free?: unknown } | undefined)?.free === true;
    const priceCeilingCents = free ? 0 : priceCeilingFromSchema(schema.data);
    const payTo = schema.data && typeof schema.data === "object" && typeof (schema.data as { pay_to?: unknown }).pay_to === "string"
      ? (schema.data as { pay_to: string }).pay_to : undefined;
    await this.rememberInspection(inspectionKey(endpoint, method), {
      endpoint,
      method,
      rail,
      priceCeilingCents,
      ...(payTo ? { payTo } : {}),
      evidence,
      inspectedAt: new Date().toISOString()
    });
    return {
      ok: true,
      data: {
        endpoint,
        method,
        rail,
        price_ceiling_cents: priceCeilingCents,
        // A free, signed call is the one thing never to move funds for; say it first.
        ...(free ? { free: true, note: (schema.data as { note?: unknown }).note } : {}),
        schema: schema.data,
        ...(reliability ? { reliability: describeReliability(reliability) } : {}),
        reputation: evidence.ok
          ? {
            score: evidence.score,
            n_eff: evidence.nEff,
            // `unproven` means insufficient trusted evidence, not a bad score.
            unproven: evidence.unproven,
            summary: evidence.summary
          }
          : { unavailable: true, error: evidence.error }
      }
    };
  }

  /**
   * A collect step waits for its job (w107 phase 2). On 2026-11-20 an org's
   * chief spent 11 of 32 Opus turns collecting five video clips, an inspect
   * and a call each, and polling clips that were still rendering. Calling a
   * job's collect step now polls it here until the job completes, fails or
   * collectTiming.waitMs runs out, so the model makes one call per clip and can
   * collect every clip in one turn. Each poll is an ordinary guarded call
   * with its own operation id (a resumed run replays the same polls); polls
   * before completion are not charged, which the seller and the gateway
   * already guarantee. `wait: false` makes a single poll.
   */
  private async callAndCollect(args: Record<string, unknown>, operationId?: string): Promise<ToolResult> {
    const first = await this.callPaidService(args, operationId);
    if (args.wait === false || !first.ok || !pendingJob(first) || !(await this.isCollect(args))) return first;
    const started = Date.now();
    let result = first;
    let polls = 1;
    let status = pendingJob(result);
    while (status && Date.now() - started < collectTiming.waitMs) {
      this.options.onProgress?.({ type: "calling_service", message: `Job ${status}; polling again` });
      await new Promise((resolve) => setTimeout(resolve, collectTiming.pollMs[Math.min(polls - 1, collectTiming.pollMs.length - 1)]));
      result = await this.callPaidService(args, operationId ? `${operationId}:poll${polls}` : undefined);
      polls += 1;
      if (!result.ok) break;
      status = pendingJob(result);
    }
    const seconds = Math.round((Date.now() - started) / 1000);
    if (!result.data || typeof result.data !== "object") return result;
    const waited = { polls, seconds, ...(status ? { still: status, note: `Still ${status} after ${seconds}s of polling by CrowdCode. Collect it again later with the same call; polls before it completes are not charged.` } : {}) };
    return { ...result, data: { ...(result.data as Record<string, unknown>), waited } };
  }

  /** Whether this call is an async job's registered collect step. */
  private async isCollect(args: Record<string, unknown>): Promise<boolean> {
    const asked = stringArg(args.url);
    if (!asked) return false;
    if (JOB_HANDLE.test(asked)) return true;
    return (await this.loadInspections()).get(inspectionKey(asked, (stringArg(args.method) ?? "GET").toUpperCase()))?.collect === true;
  }

  private async callPaidService(args: Record<string, unknown>, operationId?: string): Promise<ToolResult> {
    const session = this.options.session;
    if (this.options.approvalMode === "off") {
      return {
        ok: false,
        error: "external-service purchases are disabled (approval mode `off`). Local tools and LLM inference remain available; switch with /approval ask|auto."
      };
    }
    // `job:<handle>`: a job's collect URL, which a model copies wrong at 1,700 characters.
    const asked = stringArg(args.url);
    const endpoint = asked && JOB_HANDLE.test(asked) ? (await this.loadInspections()).get(`job ${asked}`)?.endpoint : asked;
    if (asked && JOB_HANDLE.test(asked) && !endpoint)
      return { ok: false, error: `${asked} is not a job this conversation started; use the collect url its submit returned. Nothing was paid.` };
    if (!endpoint) {
      return { ok: false, error: "call_paid_service requires `url`" };
    }
    // What the task needs from this call, for the judge (SRI-135). A job's
    // collect step inherits its submit's when the model names none.
    const statedPurpose = purposeArg(args.purpose);
    // Before any lookup or payment: a search phrase pasted into `url` is not
    // an endpoint, and "inspect it first" would be the wrong advice (SRI-119).
    const malformed = endpointProblem(endpoint);
    if (malformed) return { ok: false, error: `${malformed} Nothing was paid.` };
    const method = (stringArg(args.method) ?? (asked !== endpoint ? "GET" : "POST")).toUpperCase();
    // GET carries its inputs in the query string: a body on GET fails before payment.
    const { url: target, body } = requestFor(endpoint, method, args.body);
    const inspection = (await this.loadInspections()).get(inspectionKey(endpoint, method));
    if (!inspection) {
      return { ok: false, error: `inspect_paid_service must run for ${method} ${endpoint} before call_paid_service` };
    }
    const purpose = statedPurpose ?? inspection.purpose;
    // Only rails CrowdCode verifies end-to-end, and this payer can settle, may pay automatically.
    const rails = this.options.paymentRails ?? VERIFIED_RAILS;
    if (!rails.includes(inspection.rail)) {
      return {
        ok: false,
        error: `this endpoint offers no payment rail this agent can pay automatically (payable: ${describeRails(rails)})`
      };
    }
    // A token from an earlier purchase of this exact request is the seller's
    // documented way to make it again for free. Try that first: paying twice
    // for something already bought is the one outcome worse than a refusal.
    const reread = await this.followUpRead(target, method, body);
    if (reread) return reread;
    const requestedCostCents = intArg(args.max_cost_cents) ?? inspection.priceCeilingCents;
    let quotedCostCents = requestedCostCents;
    let quoteIdentity: unknown;
    if (session.query && !this.options.hostedSpending) {
      const fresh = await this.options.agentcash.checkEndpointSchema({ url: target, method, body });
      if (!fresh.ok) return { ok: false, error: fresh.error };
      if (railFromSchema(fresh.data) !== inspection.rail) return { ok: false, error: "The payment rail changed; inspect this service again." };
      const current = priceCeilingFromSchema(fresh.data);
      if (current !== undefined) quotedCostCents = Math.max(current, requestedCostCents ?? 0);
      quoteIdentity = fresh.data;
    }
    if (quotedCostCents === undefined) {
      return { ok: false, error: "no price ceiling: pass `max_cost_cents` (the inspection did not report a price)" };
    }

    // CrowdCode pre-check re-runs at call time; an outage or rejection blocks payment.
    const evidence = await this.serviceEvidence(endpoint);
    if (!evidence.ok) {
      return {
        ok: false,
        error: `CrowdCode reputation check is unavailable (${evidence.error}); refusing to pay without it. Retry when CrowdCode is reachable.`
      };
    }
    const minScore = this.options.minServiceScore ?? 2;
    const floorScore = evidence.floorScore ?? evidence.score;
    if (floorScore !== undefined && evidence.unproven !== true && floorScore < minScore) {
      return {
        ok: false,
        error: `CrowdCode's reviews put this service at ${floorScore.toFixed(2)} (below the ${minScore} floor); refusing to pay. ${evidence.summary ?? ""}`.trim()
      };
    }

    const approval = await this.resolveApproval(endpoint, method, quotedCostCents, evidence);
    if (!approval.ok) {
      return { ok: false, error: approval.error };
    }

    this.options.onProgress?.({ type: "reserving_spend", message: `Reserving ${quotedCostCents} cents` });
    const reservation = this.options.hostedSpending ? { id: "hosted", amountCents: 0 } : await reserveBudget(session, quotedCostCents,
      { description: `Paid tool · ${endpoint}`, identity: JSON.stringify({ operationId, endpoint: target, method, body, quoteIdentity }), forceApproval: requestedCostCents !== undefined && quotedCostCents > requestedCostCents });

    // With CrowdCode off the owner has asked for no reviews at all, and the
    // hosted gateway, which now judges every purchase by itself, is told so.
    const crowdcode = await this.crowdcodeEnabled();
    let result: PaidFetchResult;
    try {
      this.options.onProgress?.({ type: "calling_service", message: `Calling ${endpoint}` });
      result = await this.options.agentcash.fetch({
        url: target,
        operationId,
        method,
        body,
        maxAmountUsd: quotedCostCents / 100,
        rail: inspection.rail,
        ...(purpose ? { purpose } : {}),
        ...(crowdcode ? {} : { review: false })
      });
    } catch (error) {
      if (reservation) await releaseReservation(session, reservation);
      throw error;
    }

    // Reconcile the outcome. Ambiguous state-changing calls are recorded as
    // unknown, conservatively finalized at the quoted ceiling, and never
    // auto-retried.
    const outcome: PurchaseOutcome = result.ambiguous
      ? "unknown"
      : result.payment
        ? (result.ok ? "paid_success" : "paid_failure")
        : result.ok
          ? (result.authMode === "siwx" ? "siwx" : "free")
          : "free";
    const paid = outcome === "paid_success" || outcome === "paid_failure";
    const chargedCents = result.ambiguous
      ? quotedCostCents
      : paid
        ? Math.max(1, Math.round((result.payment?.paidUsd ?? quotedCostCents / 100) * 100))
        : 0;

    // A transport failure may have no trustworthy response body. Missing
    // receipt metadata occurs after a real response, so preserve that body.
    // Media leaves the process for an artifact and whatever text is left is
    // capped, before this body reaches the tool result, the saved artifact,
    // the run journal and the event details.
    if (result.data) result.data = await boundResponse(session, result.data);
    // Nothing to keep when the seller never answered: a refusal before the
    // call (the hosted gateway's `service_unreliable`, a rail it cannot pay)
    // has no status and no body, and saving it left an empty `{}` file among
    // the owner's files as if it were a receipt. Any real answer is kept,
    // errors included.
    const answered = result.status !== undefined || result.data !== undefined;
    const artifact = result.ambiguityReason === "transport" || !answered ? undefined : await saveArtifact(
      session,
      `service-calls/${Date.now()}-${slugUrl(endpoint)}.json`,
      JSON.stringify({ status: result.status, body: result.data }, null, 2),
      { endpoint, method }
    );

    const purchaseId = newPurchaseId();
    const railUsed = result.payment?.rail ?? inspection.rail;
    const supportedRail = VERIFIED_RAILS.includes(railUsed);
    const record: PurchaseRecord = {
      purchase_id: purchaseId,
      session_id: session.sessionId,
      query_id: session.query?.id,
      created_at: new Date().toISOString(),
      endpoint,
      method,
      rail: railUsed,
      quoted_cost_cents: quotedCostCents,
      charged_cost_cents: chargedCents,
      outcome,
      artifact_path: artifact?.path,
      // Our own failure, not the seller's: recorded, never reviewable.
      ...(result.callerError ? { caller_error: true } : {}),
      // x402 Solana receipts carry no payee; CrowdCode needs it to verify a new
      // service, so use the inspected offer's when the payment settled on that rail.
      evidence: result.payment && !result.payment.payTo && inspection.payTo && railUsed === inspection.rail
        ? { ...result.payment, payTo: inspection.payTo }
        : result.payment,
      ...(purpose ? { purpose } : {}),
      notes: result.ambiguous
        ? `${result.ambiguityReason ?? "ambiguous"}: payment state unknown; never auto-retried`
        : result.error
    };
    await appendPurchase(session, record);
    if (reservation) await finalizeReservation(session, reservation, outcome === "free" || outcome === "siwx" ? 0 : chargedCents);
    await appendLedgerEntry(session.ledgerPath, {
      session_id: session.sessionId,
      type: "service_call",
      resource_url: endpoint,
      method,
      quoted_cost_cents: quotedCostCents,
      charged_cost_cents: outcome === "free" || outcome === "siwx" ? 0 : chargedCents,
      status: outcome === "paid_success" ? "charged" : outcome === "unknown" ? "unknown" : outcome === "paid_failure" ? "failed" : "ok",
      approval_mode: session.approvalMode,
      artifact_path: artifact?.path,
      notes: `purchase ${purchaseId}: ${outcome}`
    });

    if (outcome === "unknown") {
      const missingReceipt = result.ambiguityReason === "missing_receipt";
      const unsupportedReceipt = result.ambiguityReason === "unsupported_receipt";
      const timedOut = result.ambiguityReason === "timeout";
      // The seller answered without a receipt: its answer is the run's to use,
      // and buying the same thing again is the mistake to prevent (SRI-96).
      // Hosted, the gateway says what is held and refuses a second purchase
      // of the same request until this one resolves.
      if (missingReceipt) {
        const held = `$${(quotedCostCents / 100).toFixed(2)}`;
        return {
          ok: false,
          data: {
            purchase_id: purchaseId,
            outcome,
            status: result.status,
            held_cost_cents: quotedCostCents,
            artifact_path: artifact?.path,
            data: result.data
          },
          error: [
            `the call to ${endpoint} returned${result.status !== undefined ? ` HTTP ${result.status}` : ""} without a verifiable settlement receipt (recorded as purchase ${purchaseId}).`,
            this.options.hostedSpending && result.error
              ? `CrowdCode: ${result.error}`
              : `Its payment state is unknown, and up to ${held} counts as spent until it is reconciled. Use the answer below; do not buy this same request again, and tell the owner ${held} is held pending.`,
            artifact?.path ? `The answer is saved at ${artifact.path}.` : ""
          ].filter(Boolean).join(" ")
        };
      }
      return {
        ok: false,
        error: unsupportedReceipt
            ? [
              `the call to ${endpoint} returned a settlement receipt on an unsupported payment rail (recorded as purchase ${purchaseId}).`,
              "It was NOT retried and must not be retried automatically; reconcile the payment manually before continuing."
            ].join(" ")
            : timedOut
              ? [
                `the call to ${endpoint} did not answer within the wait limit and its payment state is unknown (recorded as purchase ${purchaseId}).`,
                "The stored purchase was checked once without a final result. It was NOT retried and must not be retried automatically; the owner can reconcile it from the payment ledger."
              ].join(" ")
              : [
                `the call to ${endpoint} failed in transport and its payment state is unknown (recorded as purchase ${purchaseId}).`,
                "It was NOT retried and must not be retried automatically; verify the service state before calling again."
              ].join(" ")
      };
    }
    const followUp = result.ok && paid ? await this.keepFollowUp(target, method, result.data, purchaseId) : undefined;
    const collect = result.ok ? await this.registerCollect(target, { ...inspection, ...(purpose ? { purpose } : {}) }, result.data) : undefined;
    const reviewable = paid && supportedRail && !result.callerError && crowdcode;
    return {
      ok: result.ok,
      data: {
        purchase_id: purchaseId,
        outcome,
        status: result.status,
        charged_cost_cents: record.charged_cost_cents,
        artifact_path: artifact?.path,
        // Nothing is owed. Hosted: CrowdCode's judge reviews a settled
        // purchase from the platform's own record, with no call from the
        // agent. Elsewhere a review is the agent's choice. Either way, a call
        // that worked but fell short of the task is worth one review of the
        // endpoint, naming the limit (SRI-135).
        ...(reviewable
          ? { review: this.options.hostedSpending ? "automatic" : "optional",
            ...(this.reviewedEndpoints.has(reviewKey(method, endpoint)) ? {} : { if_short: SHORTFALL_REVIEW_HINT }) }
          : {}),
        ...(result.note ? { note: result.note } : {}),
        ...(followUp ? { follow_up: followUp } : {}),
        ...(collect ? { collect } : {}),
        data: result.data,
        ...(result.ok ? {} : { error: result.error })
      },
      ...(result.ok ? {} : { error: result.error })
    };
  }

  /**
   * An asynchronous job's collect step, registered so the run can call it
   * without inspecting a URL it would have to copy exactly (SRI-96 follow-up).
   * BlockRun's video submit answers with a `poll_url` of 1,700 characters
   * whose query is part of it; an agent that inspected it without the query
   * was told GET is not offered and could not collect two clips it had
   * already ordered. The collect step is the same seller, rail, payee and
   * price as the call that started the job, which is what it advertises.
   */
  private async registerCollect(target: string, inspection: Inspection, data: unknown) {
    const body = data && typeof data === "object" && !Array.isArray(data) ? data as Record<string, unknown> : undefined;
    const poll = typeof body?.poll_url === "string" ? body.poll_url : typeof body?.status_url === "string" ? body.status_url : undefined;
    if (!poll) return undefined;
    let url: string;
    try { url = new URL(poll, target).href; } catch { return undefined; }
    if (originOf(url) !== originOf(target)) return undefined;
    const registered = { ...inspection, endpoint: url, method: "GET", collect: true, inspectedAt: new Date().toISOString() };
    const job = jobHandle(url);
    await this.rememberInspection(inspectionKey(url, "GET"), registered);
    await this.rememberInspection(`job ${job}`, registered);
    return { method: "GET", job, url, inspected: true,
      note: `Collect this job with call_paid_service method GET and url "${job}" (a short handle for this url, already inspected; no inspect_paid_service needed). The call waits for the job by itself, up to ${Math.round(collectTiming.waitMs / 60000)} minutes, and polls before it completes are not charged: submit every job you need first, then collect them all in one turn instead of polling.` };
  }

  /**
   * Keep a follow-up token a paid answer carried, with the request header its
   * seller documents for it, and tell the model what it is for.
   */
  private async keepFollowUp(url: string, method: string, data: unknown, purchaseId: string) {
    const tokens = findFollowUpTokens(data);
    if (!tokens.length) return undefined;
    const fetchFree = this.options.agentcash.fetchFree?.bind(this.options.agentcash);
    const openapi = fetchFree ? await sellerOpenApi(originOf(url), async (address) => {
      const response = await fetchFree({ url: address, method: "GET" });
      return response.ok ? response.data : undefined;
    }).catch(() => undefined) : undefined;
    for (const token of tokens) {
      const header = openapi ? documentedHeader(openapi, url, method, token.field) : undefined;
      if (!header) continue;
      await saveFollowUp(this.options.session, followUpKey(method, url), { header, value: token.value, field: token.field, purchaseId, savedAt: new Date().toISOString() });
      return { header, token_field: token.field, saved: true,
        note: `The seller issued a follow-up token (${token.field}) and documents the ${header} request header for it. It is saved: calling this same URL again with call_paid_service sends ${header} automatically, and a seller that honours it answers without charging.` };
    }
    return { token_field: tokens[0].field, saved: false,
      note: `This answer carries a follow-up token (${tokens[0].field}), but the seller's OpenAPI names no request header for it. Check the seller's documentation before paying for the same request again.` };
  }

  /** The same request again with a saved follow-up token, unpaid. */
  private async followUpRead(url: string, method: string, body: unknown): Promise<ToolResult | undefined> {
    const fetchFree = this.options.agentcash.fetchFree?.bind(this.options.agentcash);
    if (!fetchFree) return undefined;
    const credential = (await loadFollowUps(this.options.session))[followUpKey(method, url)];
    if (!credential) return undefined;
    const result = await fetchFree({ url, method, body: typeof body === "string" ? body : body === undefined ? undefined : JSON.stringify(body),
      headers: { [credential.header]: credential.value } }).catch(() => undefined);
    // Only a real answer counts; a 402 means the token no longer unlocks it.
    if (!result?.ok || result.status === 402 || result.data === undefined) return undefined;
    const data = await boundResponse(this.options.session, result.data);
    const artifact = await saveArtifact(this.options.session, `service-calls/${Date.now()}-${slugUrl(url)}.json`,
      JSON.stringify({ status: result.status, body: data }, null, 2), { endpoint: url, method });
    await appendLedgerEntry(this.options.session.ledgerPath, {
      session_id: this.options.session.sessionId, type: "service_call", resource_url: url, method,
      quoted_cost_cents: 0, charged_cost_cents: 0, status: "ok", approval_mode: this.options.session.approvalMode,
      artifact_path: artifact?.path, notes: `free follow-up with ${credential.header} from purchase ${credential.purchaseId ?? "?"}`
    });
    return { ok: true, data: {
      outcome: "free", status: result.status, charged_cost_cents: 0, artifact_path: artifact?.path,
      note: `Free re-read: sent the ${credential.header} token this seller issued with your earlier purchase${credential.purchaseId ? ` ${credential.purchaseId}` : ""}; nothing was paid. This is the same content that purchase bought.`,
      data
    } };
  }

  private async resolveApproval(
    endpoint: string,
    method: string,
    quotedCostCents: number,
    evidence: ServiceEvidence
  ): Promise<{ ok: true } | { ok: false; error: string }> {
    const origin = originOf(endpoint);
    const rules = await loadApprovalRules(this.options.approvalRulesPath);
    const rule = matchApprovalRule(rules, endpoint, origin);
    if (rule?.decision === "block") {
      return { ok: false, error: `service is blocked by a stored rule: ${rule.service}` };
    }
    if (rule?.decision === "allow") {
      const capError = await this.checkCaps(rule.caps, endpoint, method, quotedCostCents);
      if (capError) {
        return { ok: false, error: capError };
      }
      return { ok: true };
    }
    if (this.options.approvalMode === "auto") {
      return { ok: true };
    }
    // ask mode with no stored rule: a human decides.
    if (!this.options.approvalHandler) {
      return {
        ok: false,
        error: `approval required for ${endpoint} and no approval prompt is available in this run mode; pre-authorize the service or use auto approval explicitly`
      };
    }
    this.options.onProgress?.({ type: "requesting_permission", message: `Waiting for approval: ${endpoint}` });
    const answer = await this.options.approvalHandler({
      endpoint,
      origin,
      method,
      quotedCostCents,
      evidenceSummary: evidence.summary ?? (evidence.unproven ? "unproven: not enough trusted reviews yet" : undefined)
    });
    switch (answer.decision) {
      case "allow_once":
        return { ok: true };
      case "always_allow": {
        await upsertApprovalRule(origin, "allow", answer.caps ?? {}, this.options.approvalRulesPath);
        const capError = await this.checkCaps(answer.caps ?? {}, endpoint, method, quotedCostCents);
        return capError ? { ok: false, error: capError } : { ok: true };
      }
      case "deny_once":
        return { ok: false, error: `the user denied this purchase: ${endpoint}. Do not retry unless the user asks.` };
      case "block":
        await upsertApprovalRule(origin, "block", {}, this.options.approvalRulesPath);
        return { ok: false, error: `the user blocked this service: ${origin}` };
    }
  }

  private async checkCaps(
    caps: { maxCostCents?: number; sessionMaxCents?: number; methods?: string[] },
    endpoint: string,
    method: string,
    quotedCostCents: number
  ): Promise<string | undefined> {
    if (caps.methods?.length && !caps.methods.map((item) => item.toUpperCase()).includes(method)) {
      return `method ${method} is not allowed for ${endpoint}`;
    }
    // New queries use the shared spending thresholds; retain non-monetary service rules.
    if (this.options.session.query) return undefined;
    if (caps.maxCostCents !== undefined && quotedCostCents > caps.maxCostCents) {
      return `quoted cost ${quotedCostCents}c exceeds the per-call cap ${caps.maxCostCents}c for ${endpoint}`;
    }
    if (caps.sessionMaxCents !== undefined) {
      const spent = (await listPurchases(this.options.session))
        .filter((state) => originOf(state.record.endpoint) === originOf(endpoint))
        .reduce((total, state) => total + state.record.charged_cost_cents, 0);
      if (spent + quotedCostCents > caps.sessionMaxCents) {
        return `quoted cost would exceed the session cap ${caps.sessionMaxCents}c for ${originOf(endpoint)} (already ${spent}c)`;
      }
    }
    return undefined;
  }

  private async reviewPaidService(args: Record<string, unknown>): Promise<ToolResult> {
    if (!(await this.crowdcodeEnabled())) return { ok: false, error: "CrowdCode is off; review submission is disabled." };
    const purchaseId = stringArg(args.purchase_id);
    const rating = intArg(args.rating);
    const reason = stringArg(args.reason);
    if (!purchaseId || rating === undefined || !reason) {
      return { ok: false, error: "review_paid_service requires purchase_id, rating (1-5), and reason" };
    }
    if (rating < 1 || rating > 5) {
      return { ok: false, error: "rating must be between 1 and 5" };
    }
    const purchases = await listPurchases(this.options.session);
    const state = purchases.find((candidate) => candidate.record.purchase_id === purchaseId);
    if (!state) {
      return { ok: false, error: `unknown purchase: ${purchaseId}` };
    }
    if (state.reviewStatus === "submitted") {
      return { ok: false, error: `purchase ${purchaseId} is already reviewed` };
    }
    if (state.reviewRejected) {
      return { ok: false, error: `CrowdCode already refused a review of purchase ${purchaseId} for a reason a retry cannot change. Nothing more is needed for it.` };
    }
    // A call that never reached the seller says nothing about the seller. On
    // 2026-10-28 an agent that could not pay — its USDC was on a network this
    // service does not accept — gave the provider one star for it, which is a
    // caller's own problem written into somebody else's reputation.
    if (state.record.caller_error) {
      return {
        ok: false,
        error: `purchase ${purchaseId} never reached ${state.record.endpoint}: it was refused before the request was sent (${state.record.notes ?? "no payment was made"}). That is not something the service did, so there is nothing to review. Fix the cause and call the service again.`
      };
    }
    // One review per endpoint per run: the first says what the endpoint is
    // like for this task, and a second about the same route adds nothing.
    const key = reviewKey(state.record.method, state.record.endpoint);
    if (this.reviewedEndpoints.has(key))
      return { ok: true, data: { purchase_id: purchaseId, review: "skipped",
        note: `This run already reviewed ${state.record.method} ${routeTemplate(state.record.endpoint)}; one review per endpoint per run is enough. Carry on with the task.` } };
    const evidence = state.record.evidence;
    // Review evidence comes from the immutable stored receipt, never the model.
    const result = await this.options.crowdcode.reviewService({
      rating,
      reason,
      paymentReference: evidence?.reference,
      reviewNonce: evidence?.reference ? undefined : state.record.purchase_id,
      apiEndpoint: state.record.endpoint,
      paymentProvider: evidence?.reference ? (state.record.rail === "mppx" ? "mppx" : "x402") : undefined,
      paymentProof: evidence?.proof,
      paymentTargetRef: evidence?.reference ? evidence.payTo : undefined,
      // Solana pays from a different address than the EVM reviewer key.
      ...(state.record.rail === "x402-solana" && evidence?.payer ? { payer: evidence.payer } : {}),
      taskContext: purposeArg(args.task_context) ?? state.record.purpose
    });
    if (!result.ok) {
      // A rejection CrowdCode decided from what is already registered will be
      // decided the same way next time. On 2026-10-27 an agent was told to
      // "retry review_paid_service" after a `service identity conflict`, spent
      // a turn and a model call doing exactly that and got the same answer. So
      // a rejection that cannot change is never presented as retryable.
      const permanent = isPermanentReviewRejection(result.error);
      await recordReviewFailed(this.options.session, purchaseId, { permanent });
      if (permanent) {
        return {
          ok: false,
          error: `CrowdCode could not attach this review to a registered service (${result.error}). This will not change on a retry. Do not call review_paid_service for ${purchaseId} again.`
        };
      }
      // Optional notes: nothing waits on them, so never spend turns retrying.
      return { ok: false, error: `CrowdCode did not take this review (${result.error}). The review is optional and nothing waits on it; carry on with the task.` };
    }
    this.reviewedEndpoints.add(key);
    await recordReviewSubmitted(this.options.session, purchaseId, rating);
    const raw = result.raw && typeof result.raw === "object" ? result.raw as Record<string, unknown> : {};
    return { ok: true, data: { purchase_id: purchaseId, review: typeof raw.review === "string" ? raw.review : "submitted", rating } };
  }

  private async bridgeUsdc(args: Record<string, unknown>, operationId?: string): Promise<ToolResult> {
    if (this.options.hostedSpending) return this.hostedBridge(args, operationId);
    if (this.options.approvalMode === "off") {
      return { ok: false, error: "financial actions are disabled (approval mode `off`)" };
    }
    const from = stringArg(args.from);
    const to = stringArg(args.to);
    const amountUsd = numberArg(args.amount_usd);
    if (!from || !to || amountUsd === undefined || amountUsd <= 0) {
      return { ok: false, error: "bridge_usdc requires from, to, and a positive amount_usd" };
    }
    if (this.options.approvalMode === "ask") {
      if (!this.options.approvalHandler) {
        return { ok: false, error: "bridging requires interactive approval and no prompt is available in this run mode" };
      }
      const answer = await this.options.approvalHandler({
        endpoint: `bridge ${from} -> ${to}`,
        origin: "agentcash-bridge",
        method: "BRIDGE",
        quotedCostCents: Math.round(amountUsd * 100)
      });
      if (answer.decision === "deny_once" || answer.decision === "block") {
        return { ok: false, error: "the user declined the bridge" };
      }
    }
    const result = await this.options.agentcash.bridge({ from, to, amountUsd });
    await appendLedgerEntry(this.options.session.ledgerPath, {
      session_id: this.options.session.sessionId,
      type: "service_call",
      resource_url: `agentcash:bridge:${from}->${to}`,
      method: "BRIDGE",
      quoted_cost_cents: Math.round(amountUsd * 100),
      charged_cost_cents: 0,
      status: result.ok ? "ok" : "failed",
      approval_mode: this.options.session.approvalMode,
      notes: result.ok ? "USDC bridge between own networks (not budget spend)" : result.error
    });
    return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error };
  }

  /**
   * Hosted moves between the agent's own networks. The hosted gateway owns the
   * quote, the owner's approval policy for the fee and the signing; an
   * approval pause propagates as a RuntimePause from the adapter.
   */
  private async hostedBridge(args: Record<string, unknown>, operationId?: string): Promise<ToolResult> {
    const transferId = stringArg(args.transfer_id);
    if (transferId) return this.options.agentcash.bridge({ from: "", to: "", amountUsd: 0, transferId });
    const from = stringArg(args.from)?.toLowerCase(), to = stringArg(args.to)?.toLowerCase(), amountUsd = numberArg(args.amount_usd);
    const networks = ["base", "solana", "tempo"];
    if (!from || !to || !networks.includes(from) || !networks.includes(to) || from === to || amountUsd === undefined || amountUsd <= 0)
      return { ok: false, error: "bridge_usdc requires two different networks (base, solana, tempo) and a positive amount_usd, or a transfer_id to check" };
    const quoteOnly = args.quote_only === true;
    const result = await this.options.agentcash.bridge({ from, to, amountUsd, quoteOnly, operationId });
    if (!quoteOnly) {
      const fee = numberArg((result.data as { fee_usd?: unknown } | undefined)?.fee_usd);
      await appendLedgerEntry(this.options.session.ledgerPath, {
        session_id: this.options.session.sessionId,
        type: "service_call",
        resource_url: `hosted:transfer:${from}->${to}`,
        method: "BRIDGE",
        quoted_cost_cents: fee === undefined ? 0 : Math.ceil(fee * 100),
        charged_cost_cents: 0,
        status: result.ok ? "ok" : "failed",
        approval_mode: this.options.session.approvalMode,
        notes: result.ok ? "USDC moved between own networks; the fee counts in the hosted run's spending" : result.error
      });
    }
    return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error };
  }

  /** Model-visible list of this session's purchases (redacted). */
  async listPurchasesRedacted(): Promise<Record<string, unknown>[]> {
    return (await listPurchases(this.options.session)).map(redactPurchase);
  }
}

/**
 * What an external service returned, made safe to keep: media becomes an
 * artifact and every remaining string is capped. Both halves matter — the
 * artifact keeps megabytes of audio or video out of every copy we make of a
 * tool result, and the cap stops a shape we have not thought of from doing
 * the same thing again.
 */
export async function boundResponse(session: SessionState, data: unknown): Promise<unknown> {
  return capStrings(await extractMedia(session, data), MAX_EXTERNAL_STRING_CHARS);
}

/** GET and HEAD send a flat object's fields as query parameters instead of a body. */
function requestFor(endpoint: string, method: string, body: unknown): { url: string; body: unknown } {
  if (method !== "GET" && method !== "HEAD") return { url: endpoint, body };
  let fields = body;
  if (typeof fields === "string") {
    try { fields = JSON.parse(fields); } catch { return { url: endpoint, body }; }
  }
  if (fields === undefined || fields === null) return { url: endpoint, body: undefined };
  if (typeof fields !== "object" || Array.isArray(fields)) return { url: endpoint, body };
  let url: URL;
  try { url = new URL(endpoint); } catch { return { url: endpoint, body }; }
  for (const [key, value] of Object.entries(fields as Record<string, unknown>)) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (item === undefined || item === null) continue;
      if (typeof item === "object") return { url: endpoint, body };
      url.searchParams.append(key, String(item));
    }
  }
  return { url: url.href, body: undefined };
}

/**
 * A short, stable name for an async job's collect URL: `job:` and the first
 * twelve hex digits of the URL's SHA-256. CrowdCode's wake after an
 * uncollected job names the same handle (hold-wakes.ts).
 */
/**
 * How long a collect step waits for its job before handing back "still
 * running", and the pauses between polls: soon at first (a clip often
 * finishes in seconds), then every 15 s. Mutable only so tests can shorten it.
 */
export const collectTiming = { waitMs: 240_000, pollMs: [5_000, 8_000, 12_000, 15_000] };
const PENDING_STATUS = /^(queued|pending|in_progress|in-progress|processing|running|submitted|starting|generating|waiting)$/i;

/** The job's state when a collect answer says it is not finished yet, else undefined. */
export function pendingJob(result: ToolResult): string | undefined {
  const data = result.ok && result.data && typeof result.data === "object" ? result.data as Record<string, unknown> : undefined;
  if (!data) return undefined;
  const inner = data.data && typeof data.data === "object" && !Array.isArray(data.data) ? data.data as Record<string, unknown> : undefined;
  const state = inner?.status ?? inner?.state;
  if (typeof state === "string") return PENDING_STATUS.test(state) ? state.toLowerCase() : undefined;
  return data.status === 202 && (data.charged_cost_cents === 0 || data.outcome === "free") ? "pending" : undefined;
}

export const jobHandle = (url: string) => `job:${createHash("sha256").update(url).digest("hex").slice(0, 12)}`;
const JOB_HANDLE = /^job:[0-9a-f]{12}$/;

/** Longest purpose kept: one sentence is the point, and the judge reads 300 characters of it. */
export const MAX_PURPOSE_CHARS = 300;
/** A stated purpose, trimmed to one line of at most MAX_PURPOSE_CHARS; undefined when blank. */
export function purposeArg(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length <= MAX_PURPOSE_CHARS ? text : `${text.slice(0, MAX_PURPOSE_CHARS - 1)}…`;
}
/** The endpoint a review is about: method and route template (SRI-135). */
export const reviewKey = (method: string, url: string) => `${method.toUpperCase()} ${routeTemplate(url)}`;
/** Shown once per endpoint on a reviewable paid result. */
export const SHORTFALL_REVIEW_HINT = "If this worked but falls short of what the task needs (a cap such as clip length or result count, partial coverage, a workaround like stitching or several calls), call review_paid_service once for this endpoint, now, naming the limit against the task. Otherwise do nothing.";

function inspectionKey(endpoint: string, method: string): string {
  return `${method} ${endpoint}`;
}

export function originOf(endpoint: string): string {
  try {
    return new URL(endpoint).origin;
  } catch {
    return endpoint;
  }
}

/** Determine the settlement rail from inspection data; unknown defaults to Base x402. */
function railFromSchema(schema: unknown): PaymentRail {
  if (schema && typeof schema === "object" && "rail" in schema) return (schema as { rail: PaymentRail }).rail;
  const text = JSON.stringify(schema ?? {}).toLowerCase();
  const mentionsTempo = text.includes("tempo") || text.includes("mpp");
  const mentionsBase = text.includes("x402") || text.includes("base");
  const mentionsSolana = text.includes("solana");
  if (mentionsSolana && !mentionsBase && !mentionsTempo) {
    return "unsupported";
  }
  if (mentionsTempo && !mentionsBase) {
    return "mppx";
  }
  return "x402-base";
}

function priceCeilingFromSchema(schema: unknown): number | undefined {
  const record = schema && typeof schema === "object" ? schema as Record<string, unknown> : {};
  const price = record.price ?? record.pricing ?? record.maxPrice ?? record.price_usd ?? record.priceUsd;
  if (typeof price === "number" && Number.isFinite(price)) {
    return Math.max(1, Math.ceil(price * 100));
  }
  if (typeof price === "string" && Number.isFinite(Number(price.replace(/[^0-9.]/g, "")))) {
    return Math.max(1, Math.ceil(Number(price.replace(/[^0-9.]/g, "")) * 100));
  }
  const nested = price && typeof price === "object" ? price as Record<string, unknown> : undefined;
  const nestedMax = nested?.max ?? nested?.usd ?? nested?.amount;
  if (typeof nestedMax === "number" && Number.isFinite(nestedMax)) {
    return Math.max(1, Math.ceil(nestedMax * 100));
  }
  return undefined;
}

function stringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function intArg(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value)) {
    return value;
  }
  return undefined;
}

function numberArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Ranked results shown by default; each carries its reliability. */
const SEARCH_LIMIT = 6;
/** A task is a sentence or a pasted request, not a document. */
const TASK_MAX_CHARS = 1500;
/** Said once per search rather than on every result. */
const RELIABILITY_NOTE = "Reliable first: it pays automatically within the owner's caps. Unverified may need the owner's approval; say so when you pick one. Unreliable is refused, so it is left out.";
/** Said once per search over CrowdCode's index (C10, C12, C13). */
const TIER_NOTE = "Ranked by CrowdCode's evidence: delivery and quality per dollar. tier proven = seen to deliver, popular = many payers and healthy; both pay automatically within the owner's caps. new = little evidence yet: it pays from the exploration allowance, and above it the owner is asked. bad is refused, so it is left out. explore: true means CrowdCode is trying it ahead of the best-known option; prefer the first fit unless the task needs otherwise.";
const COMPACT_RANKED_NOTE = "Then by quality and effective price on best_network (about $0.03 more if USDC must move there). Between equal fits prefer `networks` you already hold USDC on. Results marked inspected were probed just now: call one directly with the fields its `input` lists; inspect_paid_service only for an exact quote (sample_body) or a URL the search did not return.";
/** The discovery note's word that the probe sweep ran out of time, kept when the note is rewritten. */
function incompleteNote(data: unknown): string {
  const note = (data as { note?: unknown } | undefined)?.note;
  return typeof note === "string" && note.includes("list is partial") ? " The probe budget ran out, so this list is partial; search again or narrow the query if nothing fits." : "";
}

/** `state: first reason`, the shortest form that still says why. */
function describeReliability(reliability: Reliability): string {
  return reliability.reason ? `${reliability.state}: ${reliability.reason}` : `${reliability.state} (${reliabilityNote(reliability.state)})`;
}

/**
 * One search result as the agent reads it: what it needs to choose and pay,
 * without the fields every result repeats. `payable` is always true here,
 * `rank` is the order itself, and `network` is the first of `networks`.
 */
function compactService(service: Record<string, unknown>, reliability: Reliability | undefined): Record<string, unknown> {
  const { payable: _payable, rank: _rank, sources: _sources, payment_provider: _provider, ...rest } = service;
  void _payable; void _rank; void _sources; void _provider;
  const networks = Array.isArray(rest.networks) ? rest.networks : [];
  if (networks.length) delete rest.network;
  if (networks.length === 1 && rest.best_network === networks[0]) delete rest.best_network;
  if (rest.effective_price_usd === rest.price_usd) delete rest.effective_price_usd;
  if (typeof rest.name === "string" && rest.name.length > NAME_MAX_CHARS) rest.name = `${rest.name.slice(0, NAME_MAX_CHARS - 1)}…`;
  const quality = rest.quality as Record<string, unknown> | undefined;
  if (quality) {
    const kept = Object.fromEntries(Object.entries(quality).filter(([key, value]) => value !== undefined && value !== null && value !== 0
      && !(key === "verified_reviews" && value === quality.reviews))
      .map(([key, value]) => [key, typeof value === "number" && !Number.isInteger(value) ? Math.round(value * 10) / 10 : value]));
    if (Object.keys(kept).length) rest.quality = kept; else delete rest.quality;
  }
  if (typeof rest.tier === "string") return rest;
  return { ...rest, reliability: reliability ? describeReliability(reliability) : "unverified (CrowdCode could not say)" };
}
const NAME_MAX_CHARS = 48;

/** The probe each search result was verified with, by endpoint (see adoptProbed). */
function probesOf(data: unknown): Map<string, Record<string, unknown>> {
  const probes = new Map<string, Record<string, unknown>>();
  const services = (data as { services?: unknown } | undefined)?.services;
  for (const service of Array.isArray(services) ? services : []) {
    const probe = service && typeof service === "object" ? (service as Record<symbol, unknown>)[PROBE] : undefined;
    const endpoint = (service as { endpoint?: unknown } | undefined)?.endpoint;
    if (probe && typeof probe === "object" && typeof endpoint === "string") probes.set(endpoint, probe as Record<string, unknown>);
  }
  return probes;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
/** JSON Schema words that describe a schema rather than name an input. */
const SCHEMA_WORDS = new Set(["type", "required", "additionalProperties", "$schema", "description", "title", "properties", "items", "examples", "example", "default"]);
const INPUT_FIELDS_MAX = 10;
const INPUT_CHARS_MAX = 480;
const SHAPE_CHARS_MAX = 240;

/**
 * An endpoint's inputs in a few hundred characters: `{ query: "string,
 * required: Search query", numResults: "number" }`. Reads a plain JSON
 * Schema and the x402 discovery extension's `{ body | queryParams }` wrappers. Undefined when
 * the seller described no fields.
 */
export function describeInput(schema: unknown): Record<string, string> | undefined {
  const root = asRecord(schema);
  if (!root) return undefined;
  let fields: Record<string, unknown> = { ...(asRecord(root.properties) ?? {}) };
  const required = new Set<string>(Array.isArray(root.required) ? root.required.map(String) : []);
  for (const part of ["body", "queryParams", "query", "params"]) {
    const wrapper = asRecord(fields[part]) ?? asRecord(root[part]);
    const inner = asRecord(wrapper?.properties) ?? (wrapper && !("type" in wrapper) ? wrapper : undefined);
    if (!inner) continue;
    delete fields[part];
    fields = { ...fields, ...inner };
    for (const name of Array.isArray(wrapper?.required) ? wrapper!.required as unknown[] : []) required.add(String(name));
  }
  if (!Object.keys(fields).length)
    fields = Object.fromEntries(Object.entries(root).filter(([key]) => !SCHEMA_WORDS.has(key) && !["method", "type", "headers"].includes(key)));
  delete fields.method;
  const out: Record<string, string> = {};
  let chars = 0;
  for (const [name, value] of Object.entries(fields).slice(0, INPUT_FIELDS_MAX)) {
    const field = asRecord(value);
    const type = typeof value === "string" ? value : String(field?.type ?? (Array.isArray(field?.enum) ? "enum" : "any"));
    const choices = Array.isArray(field?.enum) ? ` one of ${field!.enum.slice(0, 6).map(String).join("|")}` : "";
    const text = typeof field?.description === "string" ? `: ${field.description.replace(/\s+/g, " ").slice(0, 64)}` : "";
    const line = `${type}${required.has(name) || field?.required === true ? ", required" : ""}${choices}${text}`;
    if (chars + name.length + line.length > INPUT_CHARS_MAX) break;
    out[name] = line;
    chars += name.length + line.length;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The answer's top-level shape, `{results[{title,url,text}],next}`, or undefined when the seller gave none. */
export function describeOutput(schema: unknown): string | undefined {
  const root = asRecord(schema);
  if (!root) return undefined;
  const shape = (value: unknown, depth: number): string => {
    const record = asRecord(value);
    if (!record) return "";
    const items = asRecord(record.items);
    if (record.type === "array" && items) return `[${shape(items, depth)}]`;
    const props = asRecord(record.properties) ?? (record.type === undefined && !("items" in record) ? record : undefined);
    if (!props || depth > 1) return "";
    const keys = Object.keys(props).filter((key) => !SCHEMA_WORDS.has(key) || props === record.properties).slice(0, 8);
    return keys.length ? `{${keys.map((key) => `${key}${shape(props[key], depth + 1)}`).join(",")}}` : "";
  };
  const text = shape(asRecord(root.example) ?? root, 0);
  return text ? text.slice(0, SHAPE_CHARS_MAX) : undefined;
}

function slugUrl(url: string): string {
  return url.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 80) || "service";
}

/**
 * The stable model-visible tool surface. Schemas never mention payment
 * proofs, payer identity, or transaction hashes: adapters obtain those from
 * immutable stored receipts.
 */
const GATEWAY_TOOL_DEFINITIONS: GatewayToolDefinition[] = [
  // crowdcode_status is not offered on its own (SRI-113): set_crowdcode_enabled without `enabled` reads the
  // same setting, which keeps a chief of staff's request within the gateway's 32 tools. It still executes.
  { name: "set_crowdcode_enabled", description: "Read or change whether CrowdCode is on. Without enabled: the current setting and the saved default. With enabled: handle 'CrowdCode on/off'; off disables reputation checks, automatic reviews and requests. Default scope is this session; scope default also sets the agent default for future sessions. Listing and deleting your reviews remain available while off. Does not change spending permissions.", parameters: { type: "object", properties: { enabled: { type: "boolean", description: "Omit to read the current setting." }, scope: { type: "string", enum: ["session", "default"] } }, additionalProperties: false } },
  { name: "request_service", description: "Before finishing a task that bought something, hit a failure or took many steps, record a concrete paid service that would have fixed an observed failure, a poor result or excessive cost. builds_on names what it could be built from today (an official API, a licensed dataset, existing paid services combined, a human-ops team). Example: input \"scanned annual-report PDFs, up to 200 pages\"; output \"one CSV per financial table with page citations and uncertain cells flagged\"; problem \"OCR drops columns and misaligns totals\"; builds_on \"a layout-aware OCR API plus table reconstruction\"; frequency per_task_like_this; price_per_call 0.5. Describe a reusable service an outside provider could build and sell, never this task's answer restated: requests that restate the task, say N/A or lack builds_on are rejected. Not for CrowdCode's own features, data or tools (a missing tool action, an internal API or report, a notice that left something out): report those with submit_harness_feedback. No names, URLs, IDs, private data or secrets. No purchase or spending authority is required. Submit distinct requests once; submit nothing if nothing qualifies. Requests stay private; CrowdCode publishes only aggregated proposals.", parameters: { type: "object", properties: {
    input: { type: "string", minLength: 20, maxLength: 600, description: "The clear input the user will give the service: format, size, fields." },
    output: { type: "string", minLength: 20, maxLength: 600, description: "The exact output they want back, specific enough to check." },
    problem: { type: "string", minLength: 20, maxLength: 800, description: "What it fixes: the failure, poor result or excessive cost observed in this task." },
    builds_on: { type: "string", minLength: 20, maxLength: 400, description: "What it could be built from today: an official API, a licensed dataset, existing paid services combined, or a human-ops team. \"Nothing exists\" is rejected." },
    frequency: { type: "string", enum: ["one_off", "per_task_like_this", "recurring"], description: "How often it would be called: once, on every task like this one, or recurring (daily or weekly)." },
    price_per_call: { type: "number", minimum: 0.000001, maximum: 100, description: "What you would pay per call, in USD: an honest estimate, not a budget the owner approved." },
    capability: { type: "string", maxLength: 80, description: "Optional capability tree node id; CrowdCode maps one when omitted." }
  }, required: ["input", "output", "problem", "builds_on", "frequency", "price_per_call"], additionalProperties: false } },
  { name: "list_my_reviews", description: "List this agent's own submitted reviews with IDs for selective deletion; works while CrowdCode is off. Paginate with next_before_id.", parameters: { type: "object", properties: { before_id: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 } }, additionalProperties: false } },
  { name: "delete_my_review", description: "Delete one of this agent's reviews when the user asks, using its ID from list_my_reviews. Works while CrowdCode is off. Never delete unrelated reviews.", parameters: { type: "object", properties: { review_id: { type: "integer", minimum: 1 } }, required: ["review_id"], additionalProperties: false } },
  { name: "read_service", description: "Read a service URL without payment, authenticating with the wallet when required (SIWX). Use this to poll a paid generation job until complete; never resubmit a pending job. Download returned media URLs with run_shell.",
    parameters: { type: "object", properties: { url: { type: "string" } }, required: ["url"], additionalProperties: false } },
  {
    name: "get_wallet_status",
    description: "Show the shared AgentCash wallet's public balances, deposit addresses, and funding links. Read-only.",
    parameters: { type: "object", properties: {}, additionalProperties: false }
  },
  {
    name: "browse_services",
    description: "Read one node of CrowdCode's capability tree (a top node such as search or image, or a leaf such as search.all): when to look, when not to buy, reliable picks with price and delivered rate, unverified candidates, and demand.",
    parameters: {
      type: "object",
      properties: { node: { type: "string", description: "Node or leaf id from the service knowledge, e.g. search, image, video.all" } },
      required: ["node"],
      additionalProperties: false
    }
  },
  {
    name: "find_paid_service",
    description: "Discover paid capability across Base, Solana and Tempo. Best: `task`, the owner's need in a sentence (or the request itself); CrowdCode's model turns it into capability searches and returns only the endpoints that fit, each with `fit` (why), or `none_fit` when nothing does. `query` searches every catalog (AgentCash, Coinbase's x402 catalog, MPP) and returns services you can pay, best first, each with its CrowdCode tier (proven, popular, new) and why, or its reliability state, ranked by delivery and quality per dollar on your best network (including a transfer between your own networks when its balance is short). Every result lists `networks`, the networks it can be paid on: when a call fails for funds, come back here and prefer an equivalent service on a network you already hold USDC on over moving funds. `origin` lists a known origin's endpoints.",
    parameters: {
      type: "object",
      properties: {
        origin: { type: "string", description: "Known API origin, e.g. https://stableenrich.dev" },
        task: { type: "string", description: "What the owner needs, in a sentence or the request itself, e.g. \"a 5 second video of ocean waves at sunset\" or \"call the bakery and ask if they have gluten-free bread\". Leave out names, contact details and secrets." },
        query: { type: "string", description: "The capability in a few words, for example \"web search\", \"object storage\" or \"solana token risk\"; not the task's subject" },
        limit: { type: "integer", minimum: 1, description: "Maximum search results" }
      },
      additionalProperties: false
    }
  },
  {
    name: "inspect_paid_service",
    description: "Inspect one endpoint before calling it: exact input schema, price ceiling, supported payment rail, CrowdCode reliability state and reputation evidence. Needed before call_paid_service only for an endpoint find_paid_service did not just return (those come back inspected, with their input fields); also gives an exact quote with sample_body.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Exact endpoint URL" },
        method: { type: "string", description: "HTTP method (default POST)" },
        sample_body: { description: "Optional sample body to probe exact pricing without paying" }
      },
      required: ["url"],
      additionalProperties: false
    }
  },
  {
    name: "call_paid_service",
    description: "Execute one inspected call through the enforced purchase lifecycle (reputation check, approval policy, budget reservation, payment, receipt). Requires a prior inspect_paid_service for the same url+method, or a find_paid_service result marked inspected.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Exact endpoint URL from inspect_paid_service" },
        method: { type: "string", description: "HTTP method (default POST)" },
        body: { description: "Request inputs matching the inspected schema; for GET they are sent as query parameters" },
        max_cost_cents: { type: "integer", minimum: 1, description: "Price ceiling in cents; defaults to the inspected price" },
        wait: { type: "boolean", description: "For a job's collect step (url job:…): false polls once instead of waiting for the job to finish (default true)." },
        purpose: { type: "string", maxLength: MAX_PURPOSE_CHARS, description: "One sentence: what the whole task needs, then this call's part of it, with the numbers (length, count, format, coverage). Example: \"the task needs a 60 s cartoon with the same two characters; this call makes clip 1 of 6\", not just \"a 10 s clip\". CrowdCode's judge reads it to say how well the service fits tasks like this, so a cap that forces several calls must be visible in it. No names, contact details, URLs or secrets. A job's collect step reuses its submit's." }
      },
      required: ["url", "purpose"],
      additionalProperties: false
    }
  },
  {
    name: "review_paid_service",
    description: "Review an endpoint you paid, once per endpoint per run, when it worked but fell short of the task: a cap (clip length, result count, page size), partial coverage, or a workaround it forced (stitching, several calls, a second service). Call it right after that call, naming the limit against the task, e.g. \"good 10 s clip with consistent characters, but each generation is capped at 10 s; the task needed 60 s, so six calls plus stitching\". Skip it when the call simply did what the task needed: on hosted agents CrowdCode's judge already reviews every paid purchase from the platform's own record and the purpose you stated. Your rating and notes are evidence the judge weighs, so report what you observed rather than arguing for a score. Distinguish provider faults from caller errors, insufficient funds, and uncertain failures.",
    parameters: {
      type: "object",
      properties: {
        purchase_id: { type: "string", description: "The purchase_id returned by call_paid_service" },
        rating: { type: "integer", minimum: 1, maximum: 5, description: "1-5: how well the response served the task" },
        reason: { type: "string", description: "What came back and the concrete limit against the task (\"max 10 s per clip; needed 60 s\")" },
        task_context: { type: "string", description: "Optional: what the task needed; defaults to the purpose stated on the call" }
      },
      required: ["purchase_id", "rating", "reason"],
      additionalProperties: false
    }
  },
  {
    name: "bridge_usdc",
    description: "Explicitly bridge USDC between this wallet's own networks (base, tempo, solana) through AgentCash. A financial action, not a purchase; subject to bridge fees, which are a flat ~$0.02-0.03 whatever the size: aim for about $1 so one fee funds many calls, and when the wallet holds less, keep the fee under about a fifth of what moves.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "Source network" },
        to: { type: "string", description: "Destination network" },
        amount_usd: { type: "number", description: "Amount of USDC to move" }
      },
      required: ["from", "to", "amount_usd"],
      additionalProperties: false
    }
  }
];

/**
 * Why `url` cannot be a paid endpoint, or undefined when it can. A run on
 * 2026-11-17 sent `https://github.com OpenClaw agent builder…` as the url of
 * a call: a search phrase where an endpoint belongs.
 */
export function endpointProblem(url: string): string | undefined {
  const shown = JSON.stringify(url.length > 120 ? `${url.slice(0, 120)}…` : url);
  if (/\s/.test(url.trim()))
    return `\`url\` must be one endpoint URL exactly as find_paid_service or inspect_paid_service returned it, and ${shown} contains spaces. Put search terms in \`body\` (or the query string), never in the URL itself.`;
  let parsed: URL;
  try { parsed = new URL(url.trim()); } catch { return `\`url\` ${shown} is not a valid URL; pass the endpoint exactly as find_paid_service or inspect_paid_service returned it.`; }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
    return `\`url\` ${shown} is not an http(s) endpoint.`;
  const host = parsed.hostname;
  if (!host || !(host.includes(".") || host === "localhost" || host.startsWith("[")))
    return `\`url\` ${shown} has no valid host; pass the endpoint exactly as find_paid_service or inspect_paid_service returned it.`;
  return undefined;
}
