import type { ActionPolicy } from "@opencrowd/protocol";

/**
 * The owner's standing "take no action" rules, enforced where the request is
 * made rather than only stated in the prompt (SRI-166).
 *
 * A real owner told their job-search org "never submit applications or take
 * action on job sites; information gathering only". A scheduled run of its
 * chief of staff then called call_paid_service on three jobs.ashbyhq.com
 * application URLs, with the tool's default method, POST. Only the
 * inspect-first rule stopped them. The rule was in the run's instructions:
 * the prompt alone did not hold.
 *
 * Reading is always allowed: GET, extraction, screenshots, a browser that
 * navigates and reads. What is refused is anything that could change
 * something on a protected site: POST, PUT, PATCH and DELETE, a form
 * submission from the shell, an autonomous browser task, and a browser
 * session's `act` on such a site. With `readOnlyWeb` every ordinary website
 * is protected; paid x402/MPP services, which sell data, stay usable.
 */

/** Per run: which page each browser session is on, so `act` knows the site it acts on. */
export interface PolicyState {
  sessionHosts: Map<string, string>;
}
export const newPolicyState = (): PolicyState => ({ sessionHosts: new Map() });

const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
/** CrowdCode's own surfaces are not third-party sites. */
const OWN_HOSTS = ["crowdcode.app", "opencrowd.dev", "localhost", "127.0.0.1"];

export function hostOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  try {
    const url = new URL(value.trim());
    return url.protocol === "http:" || url.protocol === "https:" ? url.hostname.toLowerCase() : undefined;
  } catch {
    return undefined;
  }
}

const suffixOf = (host: string, list: readonly string[]) => list.some((entry) => host === entry || host.endsWith(`.${entry}`));

/** Whether nothing may be changed on this host under the policy. */
export function protectedHost(policy: ActionPolicy, host: string | undefined): boolean {
  if (!host || suffixOf(host, OWN_HOSTS)) return false;
  return suffixOf(host, policy.noActionHosts.map((h) => h.toLowerCase()));
}

/** How every refusal starts, so the loop can tell a rule from a broken service. */
export const STANDING_RULE_REFUSAL = "Refused by the owner's standing rule";
export const isStandingRuleRefusal = (error: unknown) => typeof error === "string" && error.startsWith(STANDING_RULE_REFUSAL);

function refusal(policy: ActionPolicy, what: string, host?: string): string {
  return `${STANDING_RULE_REFUSAL}: "${policy.rule}". ${what}${host ? ` on ${host}` : ""} could change something there, so CrowdCode does not send it. `
    + "Reading is still allowed (GET, extraction, screenshots, a browser that only navigates and reads). Do not try another tool to do the same thing: "
    + "say in your answer what you did not do because of this rule, and leave that step to the owner.";
}

/** URLs anywhere in a JSON body (StableBrowser's url, Browser Use's startUrl, allowedDomains). */
function urlsIn(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6) return out;
  if (typeof value === "string") {
    for (const match of value.matchAll(/https?:\/\/[^\s"'<>)]+/g)) out.push(match[0]);
    if (/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(value.trim())) out.push(`https://${value.trim()}`);
  } else if (Array.isArray(value)) value.forEach((item) => urlsIn(item, out, depth + 1));
  else if (value && typeof value === "object") Object.values(value).forEach((item) => urlsIn(item, out, depth + 1));
  return out;
}

const parseBody = (body: unknown): unknown => {
  if (typeof body !== "string") return body;
  try { return JSON.parse(body); } catch { return body; }
};

/** A body that hands an autonomous browser agent something to do (Browser Use's task, a generic agent's goal). */
function browserTask(body: unknown): boolean {
  const record = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : undefined;
  return !!record && ["task", "goal", "instructions", "actions", "steps"].some((key) => {
    const value = record[key];
    return (typeof value === "string" && value.trim().length > 0) || (Array.isArray(value) && value.length > 0);
  });
}

/** Whether this target is protected: a listed host, or under readOnlyWeb any ordinary website. */
function guarded(policy: ActionPolicy, host: string | undefined): boolean {
  if (!host || suffixOf(host, OWN_HOSTS)) return false;
  return protectedHost(policy, host) || policy.readOnlyWeb;
}

// curl/wget/httpie/python/node: the flags and calls that send something.
const SHELL_WRITE = /(?:\s-X\s*['"]?(?:POST|PUT|PATCH|DELETE)\b|\s--request\s+['"]?(?:POST|PUT|PATCH|DELETE)\b|\s(?:-d|--data(?:-raw|-binary|-urlencode)?|-F|--form|-T|--upload-file|--json)[\s=]|\s--post-(?:data|file)[\s=]|\bhttp(?:ie)?\s+(?:POST|PUT|PATCH|DELETE)\b|\brequests\.(?:post|put|patch|delete)\s*\(|\b(?:httpx|session|client)\.(?:post|put|patch|delete)\s*\(|method\s*[:=]\s*['"](?:POST|PUT|PATCH|DELETE)['"]|\.(?:click|submit|fill|type)\s*\()/i;

/**
 * The refusal for one tool call under the policy, or undefined to let it run.
 * call_paid_service already refuses a state-changing request to a target
 * with no x402/MPP offer, so readOnlyWeb leaves paid services usable there.
 */
export function checkAction(policy: ActionPolicy | undefined, state: PolicyState, name: string, args: Record<string, unknown>): string | undefined {
  if (!policy) return undefined;
  const method = String(args.method ?? "").toUpperCase();
  switch (name) {
    case "call_paid_service":
    case "inspect_paid_service": {
      const url = typeof args.url === "string" ? args.url : "";
      const host = hostOf(url);
      const body = parseBody(args.body ?? args.sample_body);
      // A browser agent sent to a protected site acts on it, whatever the call's own host.
      const targets = urlsIn(body).map(hostOf).filter((h): h is string => !!h);
      if (browserTask(body) && (targets.some((h) => protectedHost(policy, h)) || policy.readOnlyWeb))
        return refusal(policy, "An autonomous browser task", targets.find((h) => protectedHost(policy, h)));
      // The method the call would use: an omitted one may be the tool's default POST.
      const effective = method || "POST";
      if (READ_METHODS.has(effective)) return undefined;
      if (protectedHost(policy, host)) return refusal(policy, `A ${effective} request`, host);
      return undefined;
    }
    case "read_service": {
      const url = typeof args.url === "string" ? args.url : "";
      const host = hostOf(url);
      if (READ_METHODS.has(method || "GET")) return undefined;
      const body = parseBody(args.body) as Record<string, unknown> | undefined;
      const session = typeof body?.sessionId === "string" ? body.sessionId : undefined;
      const path = (() => { try { return new URL(url).pathname; } catch { return ""; } })();
      // A browser session: navigating and reading are reads; `act` clicks and types on the page it is on.
      if (session && /\/navigate$/.test(path)) {
        const target = hostOf(body?.url);
        if (target) state.sessionHosts.set(session, target);
        return undefined;
      }
      if (session && /\/act$/.test(path)) {
        const page = state.sessionHosts.get(session);
        if (protectedHost(policy, page) || policy.readOnlyWeb) return refusal(policy, "A browser action (click, type, submit)", page);
        return undefined;
      }
      if (session) return undefined; // extract, observe, screenshot, url, close
      if (protectedHost(policy, host)) return refusal(policy, `A signed ${method} request`, host);
      return undefined;
    }
    case "vault_request": {
      const effective = method || "GET";
      if (READ_METHODS.has(effective)) return undefined;
      const host = hostOf(args.url);
      if (guarded(policy, host)) return refusal(policy, `A ${effective} request`, host);
      return undefined;
    }
    case "run_shell": {
      const command = typeof args.command === "string" ? args.command : "";
      if (!SHELL_WRITE.test(` ${command}`)) return undefined;
      const hosts = urlsIn(command).map(hostOf).filter((h): h is string => !!h);
      const hit = hosts.find((h) => protectedHost(policy, h)) ?? (policy.readOnlyWeb ? hosts.find((h) => !suffixOf(h, OWN_HOSTS)) : undefined);
      if (hit) return refusal(policy, "A shell command that sends or submits data", hit);
      return undefined;
    }
    default:
      return undefined;
  }
}
