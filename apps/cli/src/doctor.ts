import { loadConfig, configPath, readAgentCashWallet } from "@opencrowd/core";
import { sharedEconomyRuntime } from "@opencrowd/economy";
import { sharedTypedProvider } from "@opencrowd/agent-runtime";

/**
 * Explicit local dependency, provider auth, wallet, vendor connector, and
 * network diagnostics. Startup never runs these; `opencrowd doctor` is the
 * one place slow checks are allowed.
 */

interface DoctorCheck {
  name: string;
  run(): Promise<string>;
}

export async function runDoctor(log: (line: string) => void): Promise<boolean> {
  const config = await loadConfig().catch(() => undefined);
  const checks: DoctorCheck[] = [
    {
      name: "node runtime",
      run: async () => {
        const major = Number(process.versions.node.split(".")[0]);
        if (major < 20) {
          throw new Error(`Node ${process.versions.node} is too old; OpenCrowd needs >= 20`);
        }
        return `node ${process.versions.node}`;
      }
    },
    {
      name: "configuration",
      run: async () => {
        if (!config) {
          throw new Error(`config failed to load from ${configPath()}`);
        }
        return `${configPath()} (provider: ${config.provider})`;
      }
    },
    {
      name: "agentcash wallet",
      run: async () => {
        const wallet = await readAgentCashWallet();
        if (!wallet) {
          throw new Error("no wallet file; install agentcash — its wallet is created automatically on first use");
        }
        return wallet.address;
      }
    },
    {
      name: "agentcash vendor",
      run: async () => {
        const runtime = await sharedEconomyRuntime();
        const balance = await runtime.agentcash.getBalance();
        if (!balance.ok) {
          throw new Error(balance.error ?? "get_balance failed");
        }
        return "connected; balance readable";
      }
    },
    {
      name: "crowdcode vendor",
      run: async () => {
        const runtime = await sharedEconomyRuntime();
        const evidence = await runtime.crowdcode.getServiceScore({ apiEndpoint: "https://example.com/doctor-probe" });
        if (!evidence.ok) {
          throw new Error(evidence.error ?? "get_service_score failed");
        }
        return "connected; reputation checks reachable";
      }
    },
    {
      name: "llm provider",
      run: async () => {
        if (!config) {
          throw new Error("skipped: configuration failed to load");
        }
        if (config.provider === "openrouter" && !process.env.OPENROUTER_API_KEY) {
          throw new Error("OPENROUTER_API_KEY is not set");
        }
        const provider = sharedTypedProvider(config.provider, { timeoutMs: 30_000, x402ProxyUrl: config.openrouterX402ProxyUrl });
        const models = await provider.listModels();
        return `${config.provider}: ${models.length} models in catalog`;
      }
    }
  ];

  let healthy = true;
  for (const check of checks) {
    try {
      const detail = await check.run();
      log(`  ok    ${check.name.padEnd(18)} ${detail}`);
    } catch (error) {
      healthy = false;
      log(`  FAIL  ${check.name.padEnd(18)} ${(error as Error).message}`);
    }
  }
  log(healthy ? "\nall checks passed" : "\nsome checks failed — see remediation above");
  return healthy;
}
