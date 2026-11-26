/**
 * Parallel tool calls (harness experiment w123, behind a flag).
 *
 * A model reply often holds several tool calls. The loop runs them in the
 * order the model wrote them, and keeps doing so: results, checkpoints,
 * strategy hints and the tool messages the model reads stay in that order.
 * With the flag on, a run of consecutive calls that only read is started
 * together, and the loop then awaits each one in turn. Any call that is not
 * on this list is a barrier: it starts only after every call before it
 * finished, and no call after it starts before it finishes. That keeps
 * "save_file, then read_file" and "call_paid_service, then read_service"
 * as sequential as the model meant them.
 *
 * Paid and state-changing calls never run in parallel: `call_paid_service`,
 * `review_paid_service`, `bridge_usdc`, `request_service`, every control and
 * hosted tool, `save_file`, `complete_session`, subagents, and every shell
 * command except a plain read. So a payment, its hold, its approval and its
 * place in the wallet's turn (#609) are exactly as they were.
 */

/** Reads that change nothing and depend on nothing else in the reply. */
const READ_ONLY_TOOLS = new Set([
  "read_file", "list_files", "get_budget_status",
  "browse_services", "find_paid_service", "inspect_paid_service",
  "get_wallet_status", "crowdcode_status", "list_my_reviews"
]);

/** At most this many calls of one reply run at once. */
export const PARALLEL_TOOLS_MAX = 4;

/**
 * The flag: OPENCROWD_PARALLEL_TOOLS=1 runs reads together; =hint also tells
 * the model, so it batches independent reads. Anything else leaves the loop
 * exactly as it was.
 */
export function parallelToolsMode(env: NodeJS.ProcessEnv = process.env): "off" | "on" | "hint" {
  const value = env.OPENCROWD_PARALLEL_TOOLS?.trim();
  return value === "1" || value === "on" ? "on" : value === "hint" ? "hint" : "off";
}

/** Whether this call may run beside its neighbours in the reply. */
export function parallelSafe(name: string, args: Record<string, unknown>): boolean {
  if (READ_ONLY_TOOLS.has(name)) return true;
  // GET polls a job or reads what a paid call left; a POST drives a paid session in order.
  if (name === "read_service") return String(args.method ?? "GET").toUpperCase() === "GET";
  if (name === "run_shell") return typeof args.command === "string" && readOnlyShell(args.command)
    && args.background !== true;
  return false;
}

/** Programs that only print what they read, with the flags that would make them write refused below. */
const READ_PROGRAMS = new Set([
  "cat", "head", "tail", "ls", "grep", "egrep", "fgrep", "rg", "wc", "sort", "cut", "tr",
  "find", "stat", "file", "du", "df", "pwd", "echo", "printf", "date", "which", "sha256sum", "md5sum",
  "jq", "nl", "column", "basename", "dirname", "realpath", "readlink", "true", "cd", "sed", "curl"
]);
/** curl flags that write a file, send a body, change the method or read a config. */
const CURL_WRITES = /^(--output|--remote-name\S*|--request|--data\S*|--form\S*|--upload-file|--config|--cookie-jar|--dump-header|--json|--etag-save|--trace\S*|--stderr|--libcurl|--hsts|--alt-svc)$/;
/** Short curl flags (alone or bundled, `-sSo`) with the same effect. */
const CURL_SHORT_WRITES = /^-[a-zA-Z]*[oOXdFTKcD]/;
/** sed scripts that only print: an address range with p or q, or s/// with print flags. */
const SED_PRINTS = [/^(\d+|\$)?(,(\d+|\$))?[pq]$/, /^\/[^/]*\/(,\/[^/]*\/)?p$/, /^s(.)(?:(?!\1).)*\1(?:(?!\1).)*\1[gpiI\d]*$/];

/**
 * The words of each command in a pipeline or chain, or undefined for any
 * syntax this does not read with certainty: redirection, substitution, a
 * subshell, a heredoc, an escape or a background job.
 */
function shellSegments(text: string): string[][] | undefined {
  const segments: string[][] = [[]];
  let word: string | undefined, quote: "'" | "\"" | undefined;
  const end = () => { if (word !== undefined) segments[segments.length - 1].push(word); word = undefined; };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote === "'") { if (c === "'") quote = undefined; else word += c; continue; }
    if (quote === "\"") {
      if (c === "\"") quote = undefined;
      else if (c === "`" || c === "\\" || (c === "$" && /[({]/.test(text[i + 1] ?? ""))) return undefined;
      else word += c;
      continue;
    }
    if (c === "'" || c === "\"") { quote = c; word ??= ""; continue; }
    if (/\s/.test(c)) { end(); continue; }
    if (c === "|" || c === ";" || c === "&") {
      const pair = text[i + 1] === c && c !== ";";
      if (c === "&" && !pair) return undefined;
      end(); segments.push([]); if (pair) i += 1;
      continue;
    }
    if ("`<>(){}\\".includes(c) || (c === "$" && /[({]/.test(text[i + 1] ?? ""))) return undefined;
    word = (word ?? "") + c;
  }
  if (quote) return undefined;
  end();
  return segments.every(segment => segment.length) ? segments : undefined;
}

/**
 * A shell command that reads and prints, and does nothing else: a pipeline
 * or chain of the programs above, with none of the syntax `shellSegments`
 * refuses and none of the flags that would make them write. Anything this
 * cannot read with certainty is not read-only, and runs on its own as before.
 */
export function readOnlyShell(command: string): boolean {
  const text = command.trim()
    // Discarding stderr or stdout writes nothing anyone reads.
    .replace(/(^|\s)(?:[12]?>|&>)\s*\/dev\/null(?=\s|$)/g, " ").replace(/(^|\s)2>&1(?=\s|$)/g, " ");
  if (!text || text.length > 2_000 || /[\n\r]/.test(text)) return false;
  const segments = shellSegments(text);
  if (!segments) return false;
  for (const words of segments) {
    let [program, ...rest] = words;
    if (program === "timeout" && rest.length >= 2 && /^\d+[smh]?$/.test(rest[0])) [program, ...rest] = rest.slice(1);
    if (program === "command" && rest[0] === "-v") continue;
    if (!READ_PROGRAMS.has(program)) return false;
    if (program === "find" && rest.some(word => /^-(delete|exec|execdir|ok|okdir|fprint\w*|fls)$/.test(word))) return false;
    if (program === "sort" && rest.some(word => /^(-o|--output)/.test(word))) return false;
    if (program === "sed") {
      if (rest.some(word => /^(-i|--in-place|-s|--separate)/.test(word) || /^-[a-zA-Z]*i/.test(word))) return false;
      const scripts = rest.flatMap((word, i) => rest[i - 1] === "-e" ? [word] : []);
      const script = scripts.length ? scripts : [rest.find(word => !word.startsWith("-"))].filter((word): word is string => !!word);
      if (!script.length || !script.every(s => SED_PRINTS.some(pattern => pattern.test(s)))) return false;
    }
    if (program === "curl" && rest.some(word => CURL_WRITES.test(word.split("=")[0]) || CURL_SHORT_WRITES.test(word))) return false;
    if (program === "rg" && rest.some(word => /^--pre(=|$)/.test(word))) return false;
    if (program === "date" && rest.some(word => /^(-s|--set)/.test(word))) return false;
  }
  return true;
}

/** Where a call sat in a parallel group, for the trace. */
export interface ParallelSlot {
  /** The first call's id: every call started together shares it. */
  group: string;
  index: number;
  size: number;
}
