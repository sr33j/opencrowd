import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { SessionState } from "@opencrowd/core";

/**
 * Follow-up credentials: a token a seller hands back with a paid answer so
 * the same buyer can make a documented second call — a free re-read, an
 * unlock — without paying again.
 *
 * Drip returns `paymentInfo.unlockToken` with every paid post and documents,
 * in its OpenAPI, an `X-Drip-Unlock` request header that takes it: "When
 * valid for this post, returns the live summary with no charge". On
 * 2026-11-04 the agent read the saved response, did not find the token (it is
 * nested), and concluded the unlock had to be bought on another network
 * (SRI-88). Nothing here is Drip-specific: a token field, and a request
 * header the seller's own OpenAPI says takes it.
 */

/** Body fields that carry a re-read or access token. */
const TOKEN_FIELD = /^(unlock|re-?read|access|entitlement)[_-]?token$/i;
const MAX_DEPTH = 4;
const MAX_TOKEN_CHARS = 4096;
const OPENAPI_PATHS = ["/openapi.json", "/.well-known/openapi.json"];

export interface FollowUpToken {
  /** Dotted path of the field in the response body, e.g. paymentInfo.unlockToken. */
  field: string;
  value: string;
}
export interface FollowUpCredential {
  header: string;
  value: string;
  field: string;
  purchaseId?: string;
  savedAt: string;
}

/** Every token-shaped field in a JSON body, shallow first. */
export function findFollowUpTokens(body: unknown): FollowUpToken[] {
  const found: FollowUpToken[] = [];
  const walk = (value: unknown, path: string[], depth: number) => {
    if (!value || typeof value !== "object" || Array.isArray(value) || depth > MAX_DEPTH) return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (typeof child === "string" && TOKEN_FIELD.test(key) && child.length > 0 && child.length <= MAX_TOKEN_CHARS)
        found.push({ field: [...path, key].join("."), value: child });
      else walk(child, [...path, key], depth + 1);
    }
  };
  walk(body, [], 0);
  return found;
}

/** Whether an OpenAPI path template (`/a/{b}/c`) names this concrete path. */
export function matchesTemplate(template: string, path: string): boolean {
  const pattern = template.split("/").map((part) => /^\{[^}]+\}$/.test(part) ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("/");
  return new RegExp(`^${pattern}/?$`).test(path);
}

/**
 * The request header a seller documents for a token field: a header
 * parameter on this operation whose description names the field (or, failing
 * that, whose name says it unlocks). Only the operation the token came from
 * is searched, so an unrelated `Authorization` is never picked.
 */
export function documentedHeader(openapi: unknown, url: string, method: string, field: string): string | undefined {
  const paths = (openapi as { paths?: Record<string, Record<string, unknown>> } | undefined)?.paths;
  if (!paths || typeof paths !== "object") return undefined;
  const { pathname } = new URL(url);
  const leaf = field.split(".").pop()!.toLowerCase();
  for (const [template, item] of Object.entries(paths)) {
    if (!matchesTemplate(template, pathname)) continue;
    const operation = (item?.[method.toLowerCase()] ?? {}) as { parameters?: unknown[] };
    const parameters = [...((item as { parameters?: unknown[] }).parameters ?? []), ...(operation.parameters ?? [])]
      .filter((p): p is { name: string; in: string; description?: string } =>
        !!p && typeof p === "object" && (p as { in?: unknown }).in === "header" && typeof (p as { name?: unknown }).name === "string");
    const named = parameters.find((p) => (p.description ?? "").toLowerCase().includes(leaf))
      ?? parameters.find((p) => /unlock|re-?read/i.test(p.name));
    if (named && /^[A-Za-z0-9-]{1,64}$/.test(named.name) && !/^(authorization|cookie|payment-signature|x-payment)$/i.test(named.name)) return named.name;
  }
  return undefined;
}

const storePath = (session: SessionState) => join(session.sessionDir, "follow-up-credentials.json");
export const followUpKey = (method: string, url: string) => `${method.toUpperCase()} ${url}`;

export async function loadFollowUps(session: SessionState): Promise<Record<string, FollowUpCredential>> {
  try {
    const parsed = JSON.parse(await readFile(storePath(session), "utf8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function saveFollowUp(session: SessionState, key: string, credential: FollowUpCredential): Promise<void> {
  const all = await loadFollowUps(session);
  all[key] = credential;
  await writeFile(storePath(session), JSON.stringify(all, null, 2), { mode: 0o600 });
}

/** A seller's OpenAPI document, from the usual places, or nothing. */
export async function sellerOpenApi(origin: string, fetchJson: (url: string) => Promise<unknown>): Promise<unknown> {
  for (const path of OPENAPI_PATHS) {
    const document = await fetchJson(`${origin}${path}`).catch(() => undefined);
    if (document && typeof document === "object" && "paths" in (document as object)) return document;
  }
  return undefined;
}
