import { randomInt, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { bytesToHex } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { walletSecretsPath, walletsPath } from "./config.js";

const execFileAsync = promisify(execFile);
const KEYCHAIN_SERVICE = "opencrowd-wallet";

/**
 * One-wallet convergence (integration spec): when `~/.agentcash/wallet.json`
 * exists, OpenCrowd pays from the same wallet AgentCash and CrowdCode use.
 * The key stays in AgentCash's file — read at signing time, never copied.
 */
export const AGENTCASH_WALLET_ID = "agentcash";

export type StoredWalletKind = "local-evm" | "test" | "agentcash";

export interface StoredWallet {
  id: string;
  label: string;
  address: string;
  network: string;
  asset: string;
  kind: StoredWalletKind;
  created_at: string;
  mock_balance_cents?: number;
}

export interface WalletRegistry {
  active_wallet_id?: string;
  /** True when the user explicitly chose a legacy wallet over the AgentCash default. */
  explicit_selection?: boolean;
  wallets: StoredWallet[];
}

export interface WalletListEntry extends StoredWallet {
  active: boolean;
  spendable_balance?: string;
  spendable_balance_cents?: number;
}

export const FRUIT_LABELS = [
  "durian", "passionfruit", "dragonfruit", "mango", "lychee", "rambutan", "jackfruit", "guava", "papaya", "starfruit",
  "persimmon", "kumquat", "longan", "mangosteen", "cherimoya", "soursop", "pawpaw", "feijoa", "jabuticaba", "salak",
  "breadfruit", "coconut", "pineapple", "banana", "plantain", "kiwi", "fig", "date", "pomegranate", "apricot",
  "peach", "nectarine", "plum", "cherry", "blackberry", "blueberry", "raspberry", "strawberry", "cranberry", "gooseberry",
  "mulberry", "boysenberry", "elderberry", "cloudberry", "huckleberry", "marionberry", "tayberry", "loganberry", "currant", "grape",
  "watermelon", "cantaloupe", "honeydew", "casaba", "canarymelon", "orange", "bloodorange", "tangerine", "mandarin", "clementine",
  "pomelo", "grapefruit", "lemon", "lime", "yuzu", "calamansi", "bergamot", "uglifruit", "apple", "pear",
  "quince", "loquat", "medlar", "avocado", "olive", "tomato", "tomatillo", "pepino", "physalis", "ackee",
  "bael", "bilberry", "buddhashand", "cupuacu", "damson", "fingerlime", "grumichama", "hornedmelon", "jujube", "langsat",
  "lucuma", "mamoncillo", "miraclefruit", "monstera", "nance", "naranjilla", "nonifruit", "pitaya", "plantberry", "pricklypear",
  "pulasan", "quenepa", "sapodilla", "sapote", "santol", "sudachi", "surinamcherry", "tamarillo", "tamarind", "whitecurrant",
  "wineberry", "youngberry", "ziziphus", "melonpear", "roseapple", "sugarapple", "velvetapple", "woodapple", "yangmei", "zabergau"
];

export function agentCashWalletPath(): string {
  return process.env.AGENTCASH_WALLET_PATH ?? join(homedir(), ".agentcash", "wallet.json");
}

async function readAgentCashWalletFile(): Promise<{ address: string; privateKey: string } | undefined> {
  try {
    const parsed = JSON.parse(await readFile(agentCashWalletPath(), "utf8")) as Record<string, unknown>;
    const address = typeof parsed.address === "string" ? parsed.address : undefined;
    const privateKey = typeof parsed.privateKey === "string" && /^0x[0-9a-fA-F]{64}$/.test(parsed.privateKey)
      ? parsed.privateKey
      : undefined;
    return address && privateKey ? { address, privateKey } : undefined;
  } catch {
    return undefined;
  }
}

/** The shared AgentCash wallet as a virtual registry entry, when present. */
export async function agentCashStoredWallet(): Promise<StoredWallet | undefined> {
  const file = await readAgentCashWalletFile();
  if (!file) {
    return undefined;
  }
  return {
    id: AGENTCASH_WALLET_ID,
    label: AGENTCASH_WALLET_ID,
    address: file.address,
    network: "base",
    asset: "USDC",
    kind: "agentcash",
    created_at: ""
  };
}

export async function loadWalletRegistry(): Promise<WalletRegistry> {
  try {
    const text = await readFile(walletsPath(), "utf8");
    return normalizeRegistry(JSON.parse(text));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return { wallets: [] };
  }
}

export async function saveWalletRegistry(registry: WalletRegistry): Promise<void> {
  await mkdir(dirname(walletsPath()), { recursive: true });
  await writeFile(walletsPath(), `${JSON.stringify(normalizeRegistry(registry), null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(walletsPath(), 0o600).catch(() => undefined);
}

export async function createTestWallet(label?: string, initialBalanceCents = 0): Promise<StoredWallet> {
  const registry = await loadWalletRegistry();
  const resolvedLabel = resolveNewLabel(registry, label);
  const wallet: StoredWallet = {
    id: randomUUID(),
    label: resolvedLabel,
    address: `test:${randomUUID()}`,
    network: "mock-base",
    asset: "mock-USDC",
    kind: "test",
    created_at: new Date().toISOString(),
    mock_balance_cents: Math.max(0, Math.round(initialBalanceCents))
  };
  registry.wallets.push(wallet);
  registry.active_wallet_id = wallet.id;
  registry.explicit_selection = true;
  await saveWalletRegistry(registry);
  return wallet;
}

const DEFAULT_TEST_WALLET_BALANCE_CENTS = 2500;

export async function ensureDefaultTestWallet(): Promise<StoredWallet> {
  const registry = await loadWalletRegistry();
  const active = activeWalletFromRegistry(registry);
  if (active?.kind === "test" && registry.explicit_selection && registry.active_wallet_id === active.id) {
    return active;
  }
  const existing = registry.wallets.find((wallet) => wallet.kind === "test");
  if (existing) {
    registry.active_wallet_id = existing.id;
    registry.explicit_selection = true;
    await saveWalletRegistry(registry);
    return existing;
  }
  return createTestWallet(undefined, DEFAULT_TEST_WALLET_BALANCE_CENTS);
}

export async function listStoredWallets(options: { includeBalances?: boolean } = {}): Promise<WalletListEntry[]> {
  const registry = await loadWalletRegistry();
  const agentCash = await agentCashStoredWallet();
  const activeId = await resolveActiveWalletId(registry, agentCash);
  const entries = [...(agentCash ? [agentCash] : []), ...registry.wallets];
  return Promise.all(entries.map(async (wallet) => {
    const balance = options.includeBalances ? await walletBalanceForEntry(wallet).catch((error) => ({
      spendable_balance: `error: ${(error as Error).message}`
    })) : {};
    return {
      ...wallet,
      active: wallet.id === activeId,
      ...balance
    };
  }));
}

export async function activeStoredWallet(): Promise<StoredWallet> {
  const registry = await loadWalletRegistry();
  const agentCash = await agentCashStoredWallet();
  const activeId = await resolveActiveWalletId(registry, agentCash);
  if (activeId === AGENTCASH_WALLET_ID && agentCash) {
    return agentCash;
  }
  const wallet = registry.wallets.find((entry) => entry.id === activeId) ?? activeWalletFromRegistry(registry);
  if (!wallet) {
    throw new Error("No active wallet. Install agentcash (its wallet is auto-created) or run `opencrowd wallet new`.");
  }
  return wallet;
}

/**
 * The shared AgentCash wallet is the default whenever it exists; a legacy
 * wallet stays active only when the user explicitly selected it.
 */
async function resolveActiveWalletId(registry: WalletRegistry, agentCash: StoredWallet | undefined): Promise<string | undefined> {
  if (registry.active_wallet_id === AGENTCASH_WALLET_ID) {
    return agentCash ? AGENTCASH_WALLET_ID : registry.wallets[0]?.id;
  }
  if (registry.explicit_selection && registry.active_wallet_id) {
    return registry.active_wallet_id;
  }
  if (agentCash) {
    return AGENTCASH_WALLET_ID;
  }
  return registry.active_wallet_id ?? registry.wallets[0]?.id;
}

export async function setActiveStoredWallet(labelOrAddress: string): Promise<StoredWallet> {
  const registry = await loadWalletRegistry();
  if (labelOrAddress.trim().toLowerCase() === AGENTCASH_WALLET_ID) {
    const agentCash = await agentCashStoredWallet();
    if (!agentCash) {
      throw new Error(`no AgentCash wallet found at ${agentCashWalletPath()}`);
    }
    registry.active_wallet_id = AGENTCASH_WALLET_ID;
    registry.explicit_selection = false;
    await saveWalletRegistry(registry);
    return agentCash;
  }
  const wallet = resolveWallet(registry, labelOrAddress);
  registry.active_wallet_id = wallet.id;
  registry.explicit_selection = true;
  await saveWalletRegistry(registry);
  return wallet;
}

export async function fundActiveTestWallet(amountCents: number): Promise<StoredWallet> {
  if (!Number.isInteger(amountCents) || amountCents <= 0) {
    throw new Error("wallet fund amount must be a positive number of cents");
  }
  const registry = await loadWalletRegistry();
  const wallet = activeWalletFromRegistry(registry);
  if (!wallet) {
    throw new Error("No active test wallet. Run `/wallet new` in test mode first.");
  }
  if (wallet.kind !== "test") {
    throw new Error("wallet fund only works with an active test wallet");
  }
  wallet.mock_balance_cents = Math.max(0, wallet.mock_balance_cents ?? 0) + amountCents;
  await saveWalletRegistry(registry);
  return wallet;
}

export async function chargeActiveTestWallet(amountCents: number): Promise<StoredWallet | undefined> {
  if (!Number.isInteger(amountCents) || amountCents < 0) {
    throw new Error("mock wallet charge must be a non-negative integer number of cents");
  }
  const registry = await loadWalletRegistry();
  const wallet = activeWalletFromRegistry(registry);
  if (!wallet || wallet.kind !== "test") {
    return undefined;
  }
  const balance = wallet.mock_balance_cents ?? 0;
  if (balance < amountCents) {
    throw new Error(`mock wallet balance exceeded: need ${(amountCents / 100).toFixed(2)} USDC, have ${(balance / 100).toFixed(2)} USDC`);
  }
  wallet.mock_balance_cents = balance - amountCents;
  await saveWalletRegistry(registry);
  return wallet;
}

export async function exportWalletSecret(labelOrAddress: string): Promise<{ wallet: StoredWallet; mnemonic: string }> {
  const registry = await loadWalletRegistry();
  const wallet = resolveWallet(registry, labelOrAddress);
  if (wallet.kind !== "local-evm") {
    throw new Error("test wallets do not have seed phrases");
  }
  const secret = await readWalletSecret(wallet.id);
  return { wallet, mnemonic: secret.mnemonic };
}

export async function privateKeyForStoredWallet(wallet: StoredWallet): Promise<`0x${string}`> {
  if (wallet.kind === "agentcash") {
    const file = await readAgentCashWalletFile();
    if (!file) {
      throw new Error(`the AgentCash wallet at ${agentCashWalletPath()} is missing or unreadable`);
    }
    return file.privateKey as `0x${string}`;
  }
  if (wallet.kind !== "local-evm") {
    throw new Error("test wallets cannot sign real x402 payments");
  }
  const secret = await readWalletSecret(wallet.id);
  const account = mnemonicToAccount(secret.mnemonic);
  const privateKey = account.getHdKey().privateKey;
  if (!privateKey) {
    throw new Error(`wallet ${wallet.label} does not have an exportable private key`);
  }
  return bytesToHex(privateKey);
}

export function chooseFruitLabel(usedLabels: string[]): string {
  const used = new Set(usedLabels.map((label) => label.toLowerCase()));
  const available = FRUIT_LABELS.filter((fruit) => !used.has(fruit.toLowerCase()));
  if (available.length > 0) {
    return available[randomInt(available.length)];
  }
  let index = 1;
  while (used.has(`fruit-${index}`)) {
    index += 1;
  }
  return `fruit-${index}`;
}

function normalizeRegistry(raw: unknown): WalletRegistry {
  const record = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  const wallets = Array.isArray(record.wallets)
    ? record.wallets.filter(isStoredWallet).map((wallet) => ({ ...wallet, mock_balance_cents: wallet.mock_balance_cents ?? 0 }))
    : [];
  const active = record.active_wallet_id === AGENTCASH_WALLET_ID
    ? AGENTCASH_WALLET_ID
    : typeof record.active_wallet_id === "string" && wallets.some((wallet) => wallet.id === record.active_wallet_id)
      ? record.active_wallet_id
      : wallets[0]?.id;
  return { active_wallet_id: active, explicit_selection: record.explicit_selection === true, wallets };
}

function isStoredWallet(value: unknown): value is StoredWallet {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const wallet = value as Record<string, unknown>;
  return typeof wallet.id === "string"
    && typeof wallet.label === "string"
    && typeof wallet.address === "string"
    && typeof wallet.network === "string"
    && typeof wallet.asset === "string"
    && (wallet.kind === "local-evm" || wallet.kind === "test")
    && typeof wallet.created_at === "string";
}

function resolveNewLabel(registry: WalletRegistry, label?: string): string {
  const resolved = label?.trim() || chooseFruitLabel(registry.wallets.map((wallet) => wallet.label));
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(resolved)) {
    throw new Error("wallet label must be 1-64 characters and use only letters, numbers, dots, dashes, or underscores");
  }
  assertUniqueLabel(registry, resolved);
  return resolved;
}

function assertUniqueLabel(registry: WalletRegistry, label: string): void {
  if (registry.wallets.some((wallet) => wallet.label.toLowerCase() === label.toLowerCase())) {
    throw new Error(`wallet label already exists: ${label}`);
  }
}

function activeWalletFromRegistry(registry: WalletRegistry): StoredWallet | undefined {
  return registry.wallets.find((wallet) => wallet.id === registry.active_wallet_id) ?? registry.wallets[0];
}

function resolveWallet(registry: WalletRegistry, labelOrAddress: string): StoredWallet {
  const value = labelOrAddress.trim();
  const byLabel = registry.wallets.filter((wallet) => wallet.label === value);
  if (byLabel.length === 1) {
    return byLabel[0];
  }
  const byAddress = registry.wallets.filter((wallet) => wallet.address.toLowerCase() === value.toLowerCase());
  if (byAddress.length === 1) {
    return byAddress[0];
  }
  if (byLabel.length + byAddress.length > 1) {
    throw new Error(`wallet selector is ambiguous: ${labelOrAddress}`);
  }
  throw new Error(`wallet not found: ${labelOrAddress}`);
}

async function walletBalanceForEntry(wallet: StoredWallet): Promise<Pick<WalletListEntry, "spendable_balance" | "spendable_balance_cents">> {
  if (wallet.kind === "test") {
    return {
      spendable_balance: ((wallet.mock_balance_cents ?? 0) / 100).toFixed(2),
      spendable_balance_cents: wallet.mock_balance_cents ?? 0
    };
  }
  return {};
}

interface WalletSecret {
  mnemonic: string;
}

async function readWalletSecret(walletId: string): Promise<WalletSecret> {
  let value: string;
  if (useFileSecretStore()) {
    const secrets = await readFileSecrets();
    value = secrets[walletId] ?? "";
  } else if (process.platform === "darwin") {
    const result = await execFileAsync("security", ["find-generic-password", "-a", walletId, "-s", KEYCHAIN_SERVICE, "-w"]);
    value = result.stdout.trim();
  } else {
    throw new Error("No supported OS credential store found for wallet secrets.");
  }
  if (!value) {
    throw new Error(`missing wallet secret for ${walletId}`);
  }
  const parsed = JSON.parse(value) as Partial<WalletSecret>;
  if (typeof parsed.mnemonic !== "string" || parsed.mnemonic.trim() === "") {
    throw new Error(`invalid wallet secret for ${walletId}`);
  }
  return { mnemonic: parsed.mnemonic };
}

function useFileSecretStore(): boolean {
  return process.env.OPENCROWD_WALLET_SECRET_STORE === "file";
}

async function readFileSecrets(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(walletSecretsPath(), "utf8")) as Record<string, string>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
    return {};
  }
}

async function writeFileSecrets(secrets: Record<string, string>): Promise<void> {
  await mkdir(dirname(walletSecretsPath()), { recursive: true });
  await writeFile(walletSecretsPath(), `${JSON.stringify(secrets, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await chmod(walletSecretsPath(), 0o600).catch(() => undefined);
}
