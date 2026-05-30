import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { permissionsPath } from "./config.js";
import { readLedger } from "./ledger.js";
import type { PermissionEntry, PermissionMode, ServiceCaps, SessionState } from "./types.js";

interface PermissionFile {
  services: PermissionEntry[];
}

export async function loadPermissions(path = permissionsPath()): Promise<PermissionEntry[]> {
  try {
    const text = await readFile(path, "utf8");
    const parsed = JSON.parse(text) as PermissionFile;
    return parsed.services ?? [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return [];
  }
}

export async function savePermissions(entries: PermissionEntry[], path = permissionsPath()): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify({ services: entries }, null, 2)}\n`, "utf8");
}

export async function listAllowedServices(path = permissionsPath()): Promise<PermissionEntry[]> {
  return (await loadPermissions(path)).filter((entry) => entry.mode === "yolo" || entry.mode === "ask_first");
}

export async function addAllowedService(
  resourceUrl: string,
  caps: ServiceCaps = {},
  mode: PermissionMode = "yolo",
  path = permissionsPath()
): Promise<PermissionEntry> {
  const entries = await loadPermissions(path);
  const now = new Date().toISOString();
  const existing = entries.find((entry) => entry.resource_url === resourceUrl);
  const entry: PermissionEntry = {
    resource_url: resourceUrl,
    mode,
    caps,
    created_at: existing?.created_at ?? now,
    updated_at: now
  };
  const next = entries.filter((item) => item.resource_url !== resourceUrl).concat(entry);
  await savePermissions(next, path);
  return entry;
}

export async function removeAllowedService(resourceUrl: string, path = permissionsPath()): Promise<void> {
  const entries = await loadPermissions(path);
  await savePermissions(entries.filter((entry) => entry.resource_url !== resourceUrl), path);
}

export async function blockService(resourceUrl: string, path = permissionsPath()): Promise<PermissionEntry> {
  return addAllowedService(resourceUrl, {}, "blocked", path);
}

export async function requestServicePermission(
  resourceUrl: string,
  reason: string,
  caps: ServiceCaps = {},
  path = permissionsPath()
): Promise<PermissionEntry> {
  const entries = await loadPermissions(path);
  const now = new Date().toISOString();
  const existing = entries.find((entry) => entry.resource_url === resourceUrl);
  const entry: PermissionEntry = {
    resource_url: resourceUrl,
    mode: "ask_first",
    caps,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    notes: reason
  };
  await savePermissions(entries.filter((item) => item.resource_url !== resourceUrl).concat(entry), path);
  return entry;
}

export async function assertServiceAllowed(
  state: SessionState,
  resourceUrl: string,
  method: string,
  quotedCostCents: number,
  path = permissionsPath()
): Promise<PermissionEntry> {
  if (state.permissionMode === "blocked") {
    throw new Error("session permission mode is blocked");
  }
  const entry = (await loadPermissions(path)).find((item) => item.resource_url === resourceUrl);
  if (entry?.mode === "blocked") {
    throw new Error(`service is blocked: ${resourceUrl}`);
  }
  if (state.permissionMode === "ask_first" && !entry) {
    throw new Error(`permission required before paid call: ${resourceUrl}`);
  }
  const effective: PermissionEntry =
    entry ?? {
      resource_url: resourceUrl,
      mode: state.permissionMode,
      caps: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

  if (effective.caps.methods?.length && !effective.caps.methods.includes(method)) {
    throw new Error(`method not allowed for ${resourceUrl}: ${method}`);
  }
  if (effective.caps.max_cost_cents !== undefined && quotedCostCents > effective.caps.max_cost_cents) {
    throw new Error(`quoted cost exceeds service cap for ${resourceUrl}`);
  }
  if (effective.caps.session_max_cents !== undefined && (await serviceSpendCents(state, resourceUrl)) + quotedCostCents > effective.caps.session_max_cents) {
    throw new Error(`quoted cost exceeds session cap for ${resourceUrl}`);
  }
  return effective;
}

async function serviceSpendCents(state: SessionState, resourceUrl: string): Promise<number> {
  const rows = await readLedger(state.ledgerPath);
  return rows.reduce((total, row) => {
    if (row.type !== "service_call" || row.resource_url !== resourceUrl) {
      return total;
    }
    const charged = Number(row.charged_cost_cents || 0);
    return total + (Number.isFinite(charged) ? Math.round(charged) : 0);
  }, 0);
}
