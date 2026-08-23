import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { configDir, type ApprovalMode } from "@opencrowd/core";

export type { ApprovalMode };

export function isApprovalMode(value: unknown): value is ApprovalMode {
  return value === "ask" || value === "auto" || value === "off";
}

export interface ApprovalCaps {
  maxCostCents?: number;
  sessionMaxCents?: number;
  methods?: string[];
}

export interface ApprovalRule {
  /** Exact endpoint URL or origin the rule applies to (prefix match on origin). */
  service: string;
  decision: "allow" | "block";
  caps: ApprovalCaps;
  created_at: string;
  updated_at: string;
}

export interface ApprovalRequest {
  endpoint: string;
  origin: string;
  method: string;
  quotedCostCents: number;
  /** CrowdCode evidence summary shown to the human. */
  evidenceSummary?: string;
}

export type ApprovalAnswer =
  | { decision: "allow_once" }
  | { decision: "always_allow"; caps?: ApprovalCaps }
  | { decision: "deny_once" }
  | { decision: "block" };

export type ApprovalHandler = (request: ApprovalRequest) => Promise<ApprovalAnswer>;

export function approvalRulesPath(): string {
  return join(configDir(), "approvals.json");
}

interface ApprovalRulesFile {
  services: ApprovalRule[];
}

export async function loadApprovalRules(path = approvalRulesPath()): Promise<ApprovalRule[]> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as ApprovalRulesFile;
    return Array.isArray(parsed.services) ? parsed.services : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return [];
  }
}

export async function saveApprovalRules(rules: ApprovalRule[], path = approvalRulesPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ services: rules }, null, 2)}\n`, "utf8");
}

export async function upsertApprovalRule(
  service: string,
  decision: "allow" | "block",
  caps: ApprovalCaps = {},
  path = approvalRulesPath()
): Promise<ApprovalRule> {
  const rules = await loadApprovalRules(path);
  const now = new Date().toISOString();
  const existing = rules.find((rule) => rule.service === service);
  const next: ApprovalRule = {
    service,
    decision,
    caps,
    created_at: existing?.created_at ?? now,
    updated_at: now
  };
  await saveApprovalRules(rules.filter((rule) => rule.service !== service).concat(next), path);
  return next;
}

export async function removeApprovalRule(service: string, path = approvalRulesPath()): Promise<void> {
  const rules = await loadApprovalRules(path);
  await saveApprovalRules(rules.filter((rule) => rule.service !== service), path);
}

/** Longest-match rule for an endpoint: exact endpoint rule wins over origin rule. */
export function matchApprovalRule(rules: ApprovalRule[], endpoint: string, origin: string): ApprovalRule | undefined {
  return rules.find((rule) => rule.service === endpoint)
    ?? rules.find((rule) => rule.service === origin)
    ?? rules.find((rule) => rule.service !== "" && endpoint.startsWith(rule.service));
}
