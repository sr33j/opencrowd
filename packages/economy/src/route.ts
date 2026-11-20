/**
 * Route templates (`crowdcode.route.v1`, SRI-135): the endpoint a URL belongs
 * to, with record identifiers in its path written as `{id}`.
 *
 * An asynchronous job's collect step lives at a URL of its own per job
 * (BlockRun: `GET /api/v1/videos/generations/<1,600-character job id>`), so
 * reviews keyed by the exact URL scattered one service over one listing per
 * job. The same rule is applied by CrowdCode (identity.py `listing_endpoint`),
 * the hosted gateway and the CrowdCode MCP client; keep the four in step.
 *
 * A segment is an identifier when it is
 *  - four or more digits (numeric ids, timestamps),
 *  - a UUID,
 *  - 16 or more hex digits, optionally 0x-prefixed (hashes, EVM addresses),
 *  - an opaque token of 24 or more URL-safe characters mixing upper case,
 *    lower case and at least three digits (base64url job ids, Solana keys).
 * Lower-case slugs are left alone on purpose, however long: marketplaces name
 * distinct services by them (`payanagent.com/x402/kh71792ee7x7w59d…`) and data
 * APIs their series (`stationfx.com/…/market-yield-on-…-10-year-…`), and those
 * must stay separate listings.
 */
export const ID_SEGMENT = new RegExp([
  "^(?:[0-9]{4,}",
  "|[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}",
  "|(?:0x)?[0-9a-fA-F]{16,}",
  "|(?=[A-Za-z0-9_-]*[a-z])(?=[A-Za-z0-9_-]*[A-Z])(?=(?:[A-Za-z_-]*[0-9]){3})[A-Za-z0-9_-]{24,})$"
].join(""));

/** A URL path with identifier segments replaced by `{id}`. */
export function templatePath(path: string): string {
  return path.split("/").map(segment => segment && ID_SEGMENT.test(segment) ? "{id}" : segment).join("/");
}

/** `https://host/path/{id}`: origin and templated path, no query or fragment. Unparseable input is returned as is. */
export function routeTemplate(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host.toLowerCase()}${templatePath(parsed.pathname).replace(/\/+$/, "") || "/"}`;
  } catch {
    return url;
  }
}
