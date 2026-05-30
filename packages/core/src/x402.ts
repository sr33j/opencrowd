import { appendLedgerEntry } from "./ledger.js";
import { assertServiceAllowed } from "./permissions.js";
import { reserveBudget, finalizeReservation, releaseReservation } from "./budget.js";
import { saveArtifact } from "./artifacts.js";
import { createDefaultPaidHttpClient, createOwsPaymentAdapter, type PaidHttpClient, type PaymentAdapter } from "./ows.js";
import type { CallServiceInput, PaidCallResult, ProgressEvent, SessionState } from "./types.js";

export interface X402Options {
  paymentAdapter?: PaymentAdapter;
  paidHttpClient?: PaidHttpClient;
  fetchImpl?: typeof fetch;
  permissionPath?: string;
  onProgress?: (event: ProgressEvent) => void;
}

export async function callPaidService(
  state: SessionState,
  input: CallServiceInput,
  options: X402Options = {}
): Promise<PaidCallResult> {
  options.onProgress?.({ type: "checking_budget", message: "Checking session budget" });
  options.onProgress?.({ type: "checking_permission", message: `Checking permission for ${input.resource_url}` });
  await assertServiceAllowed(state, input.resource_url, input.method, input.quoted_cost_cents, options.permissionPath);

  options.onProgress?.({ type: "reserving_spend", message: `Reserving ${input.quoted_cost_cents} cents` });
  const reservation = await reserveBudget(state, input.quoted_cost_cents);
  try {
    if (options.paidHttpClient || (!options.paymentAdapter && !options.fetchImpl)) {
      options.onProgress?.({ type: "signing_with_ows", message: "Authorizing x402 service payment" });
      const client = options.paidHttpClient ?? (await createDefaultPaidHttpClient());
      options.onProgress?.({ type: "calling_service", message: `Calling ${input.resource_url}` });
      const response = await client.request({
        url: input.resource_url,
        method: input.method,
        maxCostCents: input.quoted_cost_cents,
        body: input.body,
        headers: requestHeaders(input)
      });
      const charged = response.chargedCostCents ?? (response.ok ? input.quoted_cost_cents : 0);
      await finalizeReservation(state, reservation, charged);

      options.onProgress?.({ type: "saving_artifact", message: "Saving service response artifact" });
      const artifact = await saveArtifact(
        state,
        `service-calls/${Date.now()}-${slugUrl(input.resource_url)}.json`,
        JSON.stringify({ status: response.status, headers: response.headers, body: response.body }, null, 2),
        { resource_url: input.resource_url, method: input.method }
      );

      await appendLedgerEntry(state.ledgerPath, {
        session_id: state.sessionId,
        type: "service_call",
        resource_url: input.resource_url,
        method: input.method,
        quoted_cost_cents: input.quoted_cost_cents,
        charged_cost_cents: charged,
        status: response.ok ? "charged" : "failed",
        permission_mode: state.permissionMode,
        payment_id: response.paymentId,
        tx_hash: response.txHash,
        artifact_path: artifact.path,
        notes: response.ok ? undefined : response.headers["x-opencrowd-payment-error"] ?? `HTTP ${response.status}`
      });

      return {
        status: response.status,
        headers: response.headers,
        body: response.body,
        charged_cost_cents: charged,
        tx_hash: response.txHash,
        artifact_path: artifact.path
      };
    }

    options.onProgress?.({ type: "signing_with_ows", message: "Signing payment with OWS" });
    const signer = options.paymentAdapter ?? (await createOwsPaymentAdapter());
    const signed = await signer.sign({
      resourceUrl: input.resource_url,
      method: input.method,
      quotedCostCents: input.quoted_cost_cents,
      body: input.body
    });

    options.onProgress?.({ type: "calling_service", message: `Calling ${input.resource_url}` });
    const response = await (options.fetchImpl ?? fetch)(input.resource_url, {
      method: input.method,
      headers: {
        ...requestHeaders(input),
        ...signed.headers
      },
      body: requestBody(input.body)
    });

    const responseText = await response.text();
    const parsedBody = parseBody(responseText);
    const charged = chargedCost(response, input.quoted_cost_cents);
    await finalizeReservation(state, reservation, charged);

    options.onProgress?.({ type: "saving_artifact", message: "Saving service response artifact" });
    const artifact = await saveArtifact(
      state,
      `service-calls/${Date.now()}-${slugUrl(input.resource_url)}.json`,
      JSON.stringify({ status: response.status, headers: Object.fromEntries(response.headers.entries()), body: parsedBody }, null, 2),
      { resource_url: input.resource_url, method: input.method }
    );

    await appendLedgerEntry(state.ledgerPath, {
      session_id: state.sessionId,
      type: "service_call",
      resource_url: input.resource_url,
      method: input.method,
      quoted_cost_cents: input.quoted_cost_cents,
      charged_cost_cents: charged,
      status: response.ok ? "charged" : "failed",
      permission_mode: state.permissionMode,
      tx_hash: signed.txHash,
      artifact_path: artifact.path,
      notes: response.ok ? undefined : response.headers.get("x-opencrowd-payment-error") ?? `HTTP ${response.status}`
    });

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: parsedBody,
      charged_cost_cents: charged,
      tx_hash: signed.txHash,
      artifact_path: artifact.path
    };
  } catch (error) {
    await releaseReservation(state, reservation);
    await appendLedgerEntry(state.ledgerPath, {
      session_id: state.sessionId,
      type: "service_call",
      resource_url: input.resource_url,
      method: input.method,
      quoted_cost_cents: input.quoted_cost_cents,
      charged_cost_cents: 0,
      status: "failed",
      permission_mode: state.permissionMode,
      notes: (error as Error).message
    });
    throw error;
  }
}

function parseBody(text: string): unknown {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function chargedCost(response: Response, fallback: number): number {
  const header = response.headers.get("x402-charged-cost-cents") ?? response.headers.get("x-charged-cost-cents");
  if (header && Number.isFinite(Number(header))) {
    return Math.round(Number(header));
  }
  return response.ok ? fallback : 0;
}

function requestHeaders(input: CallServiceInput): Record<string, string> | undefined {
  if (input.body === undefined) {
    return undefined;
  }
  return { "content-type": input.content_type ?? (typeof input.body === "string" ? "text/plain" : "application/json") };
}

function requestBody(body: unknown): RequestInit["body"] | undefined {
  if (body === undefined) {
    return undefined;
  }
  if (typeof body === "string") {
    return body;
  }
  return JSON.stringify(body);
}

function slugUrl(url: string): string {
  return url.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 80) || "service";
}
