import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { darwinProfile, hostAllowed, parseShellNetwork } from "../src/local-sandbox.js";

// The network allowlist is a security guard: a host it admits is one a model's command can reach.
const label = fc.stringMatching(/^[a-z0-9]([a-z0-9-]{0,10}[a-z0-9])?$/);
const host = fc.array(label, { minLength: 1, maxLength: 4 }).map((labels) => labels.join("."));

describe("network allowlist", () => {
  it("admits an exact entry only for that host, never a host that merely ends with it", () => {
    fc.assert(fc.property(host, label, (allowed, prefix) => {
      expect(hostAllowed(allowed, [allowed])).toBe(true);
      expect(hostAllowed(allowed.toUpperCase() + ".", [allowed])).toBe(true);
      expect(hostAllowed(`${prefix}.${allowed}`, [allowed])).toBe(false);
      expect(hostAllowed(`${prefix}${allowed}`, [allowed])).toBe(false);
    }));
  });

  it("admits a wildcard's subdomains and the domain itself, never a look-alike", () => {
    fc.assert(fc.property(host, label, (domain, prefix) => {
      expect(hostAllowed(domain, [`*.${domain}`])).toBe(true);
      expect(hostAllowed(`${prefix}.${domain}`, [`*.${domain}`])).toBe(true);
      expect(hostAllowed(`${prefix}${domain}`, [`*.${domain}`])).toBe(false);
      // A suffix after the domain is another domain, unless it happens to end in the domain again.
      const after = `${domain}.${prefix}`;
      expect(hostAllowed(after, [`*.${domain}`])).toBe(after.endsWith(`.${domain}`));
    }));
  });

  it("parses the setting, and refuses anything that is not a host name", () => {
    expect(parseShellNetwork(undefined)).toEqual({ mode: "open" });
    expect(parseShellNetwork("off")).toEqual({ mode: "off" });
    expect(parseShellNetwork("https://Example.com/x, *.github.com")).toEqual({ mode: "allow", hosts: ["example.com", "*.github.com"] });
    fc.assert(fc.property(fc.string(), (text) => {
      try {
        const parsed = parseShellNetwork(text);
        if (parsed.mode === "allow") for (const entry of parsed.hosts) expect(entry).toMatch(/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/);
      } catch (error) { expect(String(error)).toContain("not a host name"); }
    }));
  });

  it("writes a macOS profile that confines writes and hides credentials, quoting every path", () => {
    const profile = darwinProfile({ workspace: '/Users/a b/"w"', home: "/Users/a b", network: { mode: "allow", hosts: ["x.com"] }, proxyPort: 4242, readOnly: [] });
    expect(profile).toContain('(require-not (subpath "/Users/a b/\\"w\\""))');
    expect(profile).toContain('(subpath "/Users/a b/.agentcash")');
    expect(profile).toContain('(allow network-outbound (remote ip "localhost:4242"))');
  });
});
