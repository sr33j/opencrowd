import { CrowdCodePreferences } from "./crowdcode-preferences.js";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { extractMedia } from "./media.js";
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
import {
  loadApprovalRules,
  matchApprovalRule,
  upsertApprovalRule,
  type ApprovalHandler,
  type ApprovalMode
} from "./approvals.js";
import {
  appendPurchase, skipPendingReviews,
  listPurchases,
  newPurchaseId,
  pendingRequiredReviews,
  recordReviewSubmitted, recordReviewFailed, MAX_REVIEW_ATTEMPTS,
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
 *   artifact + immutable receipt -> finalize/release -> required review ->
 *   audit entry
 */

export const GATEWAY_TOOL_NAMES = [
  "crowdcode_status", "set_crowdcode_enabled", "request_service", "list_my_reviews", "delete_my_review",
  "read_service",
  "get_wallet_status",
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
  onProgress?: (event: ProgressEvent) => void;
}

export class EconomyGateway {
  /**
   * Inspections are keyed by endpoint+method and persisted under the session so
   * a run resumed on a fresh gateway instance (funds pause, worker restart) still
   * honours the inspect-before-call rule instead of failing its first call.
   */
  private inspections?: Map<string, Inspection>;

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
    const map = await this.loadInspections();
    map.set(key, inspection);
    await writeFile(this.inspectionsPath, JSON.stringify(Object.fromEntries(map)), "utf8");
  }

  definitions(): GatewayToolDefinition[] {
    return GATEWAY_TOOL_DEFINITIONS;
  }

  hasTool(name: string): boolean {
    return (GATEWAY_TOOL_NAMES as readonly string[]).includes(name);
  }

  /** True while a confirmed paid purchase still needs its required review. */
  async hasPendingRequiredReviews(): Promise<boolean> {
    return await this.crowdcodeEnabled() && (await pendingRequiredReviews(this.options.session)).length > 0;
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
        case "find_paid_service":
          return await this.findPaidService(args);
        case "inspect_paid_service":
          return await this.inspectPaidService(args);
        case "call_paid_service":
          return await this.callPaidService(args, operationId);
        case "review_paid_service":
          return await this.reviewPaidService(args);
        case "read_service":
          return this.options.agentcash.read ? await this.options.agentcash.read(String(args.url ?? "")) : { ok: false, error: "Authenticated reads are unavailable" };
        case "bridge_usdc":
          return await this.bridgeUsdc(args);
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
    if (name === "set_crowdcode_enabled") {
      if (typeof args.enabled !== "boolean" || (args.scope !== undefined && args.scope !== "session" && args.scope !== "default"))
        return { ok: false, error: "Provide enabled (boolean) and scope (session or default)" };
    }
    if (this.options.hostedSpending && (name === "crowdcode_status" || name === "set_crowdcode_enabled")) {
      const preferences = new CrowdCodePreferences(this.options.session);
      const data = name === "crowdcode_status" ? await preferences.status() : await preferences.set(args.enabled as boolean, (args.scope ?? "session") as "session" | "default");
      if (name === "set_crowdcode_enabled" && args.enabled === false) await skipPendingReviews(this.options.session);
      return { ok: true, data };
    }
    if (name === "request_service" && !(await this.crowdcodeEnabled())) return { ok: false, error: "CrowdCode is off. Turn it on to submit service requests." };
    if (!this.options.crowdcode.manage) return { ok: false, error: "CrowdCode management is unavailable" };
    const result = await this.options.crowdcode.manage(name, args);
    if (result.ok && name === "set_crowdcode_enabled" && args.enabled === false) await skipPendingReviews(this.options.session);
    return result;
  }

  private async serviceEvidence(endpoint: string): Promise<ServiceEvidence> {
    return await this.crowdcodeEnabled() ? this.options.crowdcode.getServiceScore({ apiEndpoint: endpoint })
      : { ok: true, unproven: true, summary: "CrowdCode is off; reputation checks and submissions are disabled." };
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
    const query = stringArg(args.query);
    if (origin) {
      const result = await this.options.agentcash.discoverEndpoints(origin);
      return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error };
    }
    if (query) {
      const result = await this.options.agentcash.search(query, { limit: intArg(args.limit) });
      return result.ok ? { ok: true, data: result.data } : { ok: false, error: result.error };
    }
    return { ok: false, error: "find_paid_service requires `origin` (known origin) or `query` (capability search)" };
  }

  private async inspectPaidService(args: Record<string, unknown>): Promise<ToolResult> {
    const endpoint = stringArg(args.url);
    if (!endpoint) {
      return { ok: false, error: "inspect_paid_service requires `url`" };
    }
    const method = (stringArg(args.method) ?? "POST").toUpperCase();
    const schema = await this.options.agentcash.checkEndpointSchema({
      url: endpoint,
      method,
      body: args.sample_body
    });
    if (!schema.ok) {
      return { ok: false, error: schema.error };
    }
    const evidence = await this.serviceEvidence(endpoint);
    const rail = railFromSchema(schema.data);
    const priceCeilingCents = priceCeilingFromSchema(schema.data);
    await this.rememberInspection(inspectionKey(endpoint, method), {
      endpoint,
      method,
      rail,
      priceCeilingCents,
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
        schema: schema.data,
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

  private async callPaidService(args: Record<string, unknown>, operationId?: string): Promise<ToolResult> {
    const session = this.options.session;
    if (this.options.approvalMode === "off") {
      return {
        ok: false,
        error: "external-service purchases are disabled (approval mode `off`). Local tools and LLM inference remain available; switch with /approval ask|auto."
      };
    }
    // A confirmed paid purchase with a pending required review blocks further purchases.
    const pending = await this.crowdcodeEnabled() ? await pendingRequiredReviews(session) : [];
    if (pending.length > 0) {
      return {
        ok: false,
        error: `a paid purchase requires its CrowdCode review before another purchase: review_paid_service purchase_id=${pending[0].record.purchase_id}`
      };
    }
    const endpoint = stringArg(args.url);
    if (!endpoint) {
      return { ok: false, error: "call_paid_service requires `url`" };
    }
    const method = (stringArg(args.method) ?? "POST").toUpperCase();
    const inspection = (await this.loadInspections()).get(inspectionKey(endpoint, method));
    if (!inspection) {
      return { ok: false, error: `inspect_paid_service must run for ${method} ${endpoint} before call_paid_service` };
    }
    // Only rails CrowdCode verifies end-to-end may pay automatically.
    if (inspection.rail !== "x402-base") {
      return {
        ok: false,
        error: "this endpoint settles on a payment rail OpenCrowd does not support for automatic payment (allowed: x402 USDC on Base)"
      };
    }
    const requestedCostCents = intArg(args.max_cost_cents) ?? inspection.priceCeilingCents;
    let quotedCostCents = requestedCostCents;
    let quoteIdentity: unknown;
    if (session.query && !this.options.hostedSpending) {
      const fresh = await this.options.agentcash.checkEndpointSchema({ url: endpoint, method, body: args.body });
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
    if (evidence.score !== undefined && evidence.unproven !== true && evidence.score < minScore) {
      return {
        ok: false,
        error: `CrowdCode rates this service ${evidence.score.toFixed(2)} (below the ${minScore} floor); refusing to pay. ${evidence.summary ?? ""}`.trim()
      };
    }

    const approval = await this.resolveApproval(endpoint, method, quotedCostCents, evidence);
    if (!approval.ok) {
      return { ok: false, error: approval.error };
    }

    this.options.onProgress?.({ type: "reserving_spend", message: `Reserving ${quotedCostCents} cents` });
    const reservation = this.options.hostedSpending ? { id: "hosted", amountCents: 0 } : await reserveBudget(session, quotedCostCents,
      { description: `Paid tool · ${endpoint}`, identity: JSON.stringify({ operationId, endpoint, method, body: args.body, quoteIdentity }), forceApproval: requestedCostCents !== undefined && quotedCostCents > requestedCostCents });

    let result: PaidFetchResult;
    try {
      this.options.onProgress?.({ type: "calling_service", message: `Calling ${endpoint}` });
      result = await this.options.agentcash.fetch({
        url: endpoint,
        operationId,
        method,
        body: args.body,
        maxAmountUsd: quotedCostCents / 100,
        rail: inspection.rail
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
    if (result.data) result.data = await extractMedia(session, result.data);
    const artifact = result.ambiguityReason === "transport" ? undefined : await saveArtifact(
      session,
      `service-calls/${Date.now()}-${slugUrl(endpoint)}.json`,
      JSON.stringify({ status: result.status, body: result.data }, null, 2),
      { endpoint, method }
    );

    const purchaseId = newPurchaseId();
    const railUsed = result.payment?.rail ?? inspection.rail;
    const supportedRail = railUsed === "x402-base" || railUsed === "mppx";
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
      // Confirmed paid successes AND paid failures require reviews; free,
      // SIWX, and unknown outcomes create no paid receipt to review.
      review_required: paid && supportedRail && await this.crowdcodeEnabled(),
      evidence: result.payment,
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
      return {
        ok: false,
        error: missingReceipt
          ? [
            `the call to ${endpoint} returned but indicated payment without a verifiable settlement receipt (recorded as purchase ${purchaseId}).`,
            "Its payment state is unknown. It was NOT retried and must not be retried automatically; inspect the saved artifact and reconcile with AgentCash before continuing."
          ].join(" ")
          : unsupportedReceipt
            ? [
              `the call to ${endpoint} returned a settlement receipt on an unsupported payment rail (recorded as purchase ${purchaseId}).`,
              "It was NOT retried and must not be retried automatically; reconcile the payment manually before continuing."
            ].join(" ")
            : [
              `the call to ${endpoint} failed in transport and its payment state is unknown (recorded as purchase ${purchaseId}).`,
              "It was NOT retried and must not be retried automatically; verify the service state before calling again."
            ].join(" ")
      };
    }
    return {
      ok: result.ok,
      data: {
        purchase_id: purchaseId,
        outcome,
        status: result.status,
        charged_cost_cents: record.charged_cost_cents,
        artifact_path: artifact?.path,
        review_required: record.review_required,
        review_available: true,
        data: result.data,
        ...(result.ok ? {} : { error: result.error })
      },
      ...(result.ok ? {} : { error: result.error })
    };
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
      taskContext: stringArg(args.task_context)
    });
    if (!result.ok) {
      await recordReviewFailed(this.options.session, purchaseId);
      const deferred = (state.reviewAttempts ?? 0) + 1 >= MAX_REVIEW_ATTEMPTS;
      return { ok: false, error: `CrowdCode review failed (${result.error}); the review stays pending${deferred ? " for manual retry, without blocking completion or later purchases" : " — retry review_paid_service"}` };
    }
    await recordReviewSubmitted(this.options.session, purchaseId, rating);
    return { ok: true, data: { purchase_id: purchaseId, review: "submitted", rating } };
  }

  private async bridgeUsdc(args: Record<string, unknown>): Promise<ToolResult> {
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

  /** Model-visible list of this session's purchases (redacted). */
  async listPurchasesRedacted(): Promise<Record<string, unknown>[]> {
    return (await listPurchases(this.options.session)).map(redactPurchase);
  }
}

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

function slugUrl(url: string): string {
  return url.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 80) || "service";
}

/**
 * The stable model-visible tool surface. Schemas never mention payment
 * proofs, payer identity, or transaction hashes: adapters obtain those from
 * immutable stored receipts.
 */
const GATEWAY_TOOL_DEFINITIONS: GatewayToolDefinition[] = [
  { name: "crowdcode_status", description: "Check whether CrowdCode is enabled for this session and by default.", parameters: { type: "object", properties: {}, additionalProperties: false } },
  { name: "set_crowdcode_enabled", description: "Handle 'CrowdCode on/off'. Disable reputation checks, automatic reviews and requests. Default scope is this session; scope default also sets the agent default for future sessions. Listing and deleting your reviews remain available while off. Does not change spending permissions.", parameters: { type: "object", properties: { enabled: { type: "boolean" }, scope: { type: "string", enum: ["session", "default"] } }, required: ["enabled"], additionalProperties: false } },
  { name: "request_service", description: "Before finishing a real task, record a concrete service worth paying for that would fix an observed failure, poor result, excessive cost or detour. State exact input, paid deliverable, acceptance criteria, actual obstacle and why paying is worthwhile. No purchase or spending authority is required. Skip generic Python/runtime wishes, web search that worked well, and gaps without a sellable remedy. Submit distinct gaps once; submit nothing if everything worked well and cheaply. Exclude private data and secrets.", parameters: { type: "object", properties: { service_description: { type: "string", maxLength: 8000 }, task_context: { type: "string", maxLength: 4000 } }, required: ["service_description"], additionalProperties: false } },
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
    name: "find_paid_service",
    description: "Discover paid capability: pass `origin` to list a known origin's endpoints, or `query` to search for an unknown capability.",
    parameters: {
      type: "object",
      properties: {
        origin: { type: "string", description: "Known API origin, e.g. https://stableenrich.dev" },
        query: { type: "string", description: "Natural-language capability search when no origin is known" },
        limit: { type: "integer", minimum: 1, description: "Maximum search results" }
      },
      additionalProperties: false
    }
  },
  {
    name: "inspect_paid_service",
    description: "Inspect one endpoint before calling it: exact input schema, price ceiling, supported payment rail, and CrowdCode reputation evidence. Required before call_paid_service.",
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
    description: "Execute one inspected call through the enforced purchase lifecycle (reputation check, approval policy, budget reservation, payment, receipt). Requires a prior inspect_paid_service for the same url+method.",
    parameters: {
      type: "object",
      properties: {
        url: { type: "string", description: "Exact endpoint URL from inspect_paid_service" },
        method: { type: "string", description: "HTTP method (default POST)" },
        body: { description: "Request body matching the inspected schema" },
        max_cost_cents: { type: "integer", minimum: 1, description: "Price ceiling in cents; defaults to the inspected price" }
      },
      required: ["url"],
      additionalProperties: false
    }
  },
  {
    name: "review_paid_service",
    description: "Review a stored service interaction, paid or unpaid, using the same CrowdCode review flow. Payment evidence is attached when available; otherwise payment is marked unverified. Required after confirmed paid calls, optional for unpaid outcomes. Describe observed results and distinguish provider faults from caller errors, insufficient funds, and uncertain failures.",
    parameters: {
      type: "object",
      properties: {
        purchase_id: { type: "string", description: "The purchase_id returned by call_paid_service" },
        rating: { type: "integer", minimum: 1, maximum: 5, description: "1-5: judge whether the response actually helped the original task" },
        reason: { type: "string", description: "Concrete review text (what worked/failed)" },
        task_context: { type: "string", description: "Optional: the task this purchase served" }
      },
      required: ["purchase_id", "rating", "reason"],
      additionalProperties: false
    }
  },
  {
    name: "bridge_usdc",
    description: "Explicitly bridge USDC between this wallet's own networks (base, tempo, solana) through AgentCash. A financial action, not a purchase; subject to bridge fees.",
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
