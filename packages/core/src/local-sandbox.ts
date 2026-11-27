import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, request as httpRequest, type Server } from "node:http";
import { connect, type Socket } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * A sandbox for the local CLI's `run_shell` (harness experiment 3, second part).
 *
 * A hosted agent's commands already run as a separate user in their own PID
 * namespace (`OPENCROWD_SHELL_SANDBOX`). A local one runs as the owner, with
 * everything the owner can reach: the AgentCash wallet key in
 * `~/.agentcash/wallet.json` is one `cat` away from a model that read the
 * wrong web page. So each command runs instead:
 *
 * - **writing** only inside the workspace and a private temporary directory,
 *   with the session's own books (its budget, ledger and conversation) read-only;
 * - **reading** everything else except the places credentials live
 *   (`CREDENTIAL_PATHS`), which are hidden;
 * - in its own PID namespace on Linux, so it cannot see or signal this process;
 * - with the network `open` (the default), `off`, or limited to an allowlist of
 *   hosts (`OPENCROWD_SHELL_NETWORK=off` or `=example.com,*.github.com`). An
 *   allowlist is enforced by a proxy in this process: the command has no
 *   network of its own, only `HTTP(S)_PROXY`, and the proxy refuses every
 *   host not on the list. A program that ignores the proxy variables gets no
 *   network at all, and DNS goes nowhere but through the proxy.
 *
 * Linux uses bubblewrap (`bwrap`), macOS `sandbox-exec`. Where neither can
 * run (bubblewrap is not installed, or the system forbids unprivileged
 * namespaces) a command runs as it always did, and the ledger and
 * `opencrowd doctor` say why. A network the owner restricted is never
 * opened that way: with `off` or an allowlist, the command is refused.
 */
export type ShellNetwork = { mode: "open" } | { mode: "off" } | { mode: "allow"; hosts: string[] };
export interface LocalSandboxSettings { network: ShellNetwork }

/** Where credentials usually live, relative to `$HOME`. Hidden from every sandboxed command. */
export const CREDENTIAL_PATHS = [
  ".agentcash", ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".netrc", ".git-credentials", ".npmrc", ".pypirc",
  ".config/opencrowd", ".config/gh", ".config/gcloud", ".config/op", ".password-store", "Library/Keychains"
] as const;

export function localSandboxSettings(env: NodeJS.ProcessEnv = process.env): LocalSandboxSettings {
  return { network: parseShellNetwork(env.OPENCROWD_SHELL_NETWORK) };
}

export function parseShellNetwork(value: string | undefined): ShellNetwork {
  const text = value?.trim().toLowerCase();
  if (!text || text === "open") return { mode: "open" };
  if (text === "off" || text === "none") return { mode: "off" };
  const hosts = text.split(/[\s,]+/).map((host) => host.replace(/^https?:\/\//, "").replace(/[/:].*$/, "")).filter(Boolean);
  for (const host of hosts) if (!/^(\*\.)?[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(host)) throw new Error(`OPENCROWD_SHELL_NETWORK: not a host name: ${host}`);
  return hosts.length ? { mode: "allow", hosts } : { mode: "off" };
}

/** `example.com` admits itself; `*.example.com` admits its subdomains and itself. */
export function hostAllowed(host: string, allow: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, "");
  return allow.some((entry) => entry.startsWith("*.") ? name === entry.slice(2) || name.endsWith(entry.slice(1)) : name === entry);
}

export interface SandboxedCommand {
  program: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** Stops the allowlist proxy, if one was started. */
  close(): Promise<void>;
}

/** The program and arguments that run `command` confined, with the proxy it needs already listening. */
export async function sandboxCommand(input: {
  command: string; cwd: string; workspaceRoot: string; env: NodeJS.ProcessEnv; settings: LocalSandboxSettings;
  /** Files the command may read but never write: the session's own books. */
  readOnly?: string[];
  platform?: NodeJS.Platform; home?: string;
}): Promise<SandboxedCommand> {
  const platform = input.platform ?? process.platform, home = input.home ?? homedir();
  const workspace = resolve(input.workspaceRoot);
  const proxy = input.settings.network.mode === "allow" ? await startProxy(input.settings.network.hosts, platform === "linux") : undefined;
  const proxyEnv = proxy ? proxyVariables(`http://127.0.0.1:${proxy.innerPort}`) : {};
  try {
    if (platform === "linux") {
      const scratch = await mkdtemp(join(tmpdir(), "opencrowd-shell-"));
      const args = linuxArguments({ ...input, workspace, home, scratch, proxy });
      return { program: "bwrap", args, env: { ...input.env, ...proxyEnv, TMPDIR: "/tmp" },
        close: async () => { await proxy?.close(); await rm(scratch, { recursive: true, force: true }); } };
    }
    if (platform === "darwin") {
      const profile = darwinProfile({ workspace, home, network: input.settings.network, proxyPort: proxy?.innerPort, readOnly: input.readOnly ?? [] });
      return { program: "/usr/bin/sandbox-exec", args: ["-p", profile, "/bin/sh", "-c", input.command], env: { ...input.env, ...proxyEnv },
        close: async () => { await proxy?.close(); } };
    }
    throw new Error(`the shell sandbox is not supported on ${platform}`);
  } catch (error) {
    await proxy?.close();
    throw error;
  }
}

function linuxArguments(input: {
  command: string; cwd: string; workspace: string; home: string; scratch: string; readOnly?: string[];
  settings: LocalSandboxSettings; proxy?: Proxy;
}): string[] {
  const args = ["--die-with-parent", "--new-session", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try",
    "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc",
    // A private /tmp and /run: other programs' sockets (an ssh agent, Docker, D-Bus) live there.
    "--bind", input.scratch, "/tmp", "--tmpfs", "/run"];
  // Later mounts cover earlier ones, so the masks come after the workspace:
  // a workspace that is $HOME itself must not bring the credentials back.
  args.push("--bind", input.workspace, input.workspace);
  for (const path of input.readOnly ?? []) if (existsSync(path)) args.push("--ro-bind", path, path);
  for (const path of CREDENTIAL_PATHS.map((relative) => join(input.home, relative))) {
    if (!existsSync(path)) continue;
    args.push(...(statSync(path).isDirectory() ? ["--tmpfs", path] : ["--ro-bind", "/dev/null", path]));
  }
  if (input.settings.network.mode !== "open") args.push("--unshare-net");
  if (input.proxy?.socketPath) args.push("--ro-bind", input.proxy.socketPath, PROXY_SOCKET_INSIDE);
  args.push("--chdir", input.cwd, "--");
  // With an allowlist the command's only way out is a TCP port on its own
  // loopback, bridged by this runtime's Node to the proxy's Unix socket.
  if (input.proxy?.socketPath) args.push(process.execPath, "-e", BRIDGE, PROXY_SOCKET_INSIDE, String(input.proxy.innerPort), "/bin/sh", "-c", input.command);
  else args.push("/bin/sh", "-c", input.command);
  return args;
}

const PROXY_SOCKET_INSIDE = "/run/opencrowd-proxy.sock";
/** Inside the sandbox: listen on loopback, forward to the proxy socket, run the command, exit with its status. */
const BRIDGE = `const net=require("node:net"),{spawn}=require("node:child_process");const[sock,port,...cmd]=process.argv.slice(1);
const s=net.createServer(c=>{const u=net.connect(sock);c.pipe(u).pipe(c);c.on("error",()=>u.destroy());u.on("error",()=>c.destroy());});
s.listen(Number(port),"127.0.0.1",()=>{const p=spawn(cmd[0],cmd.slice(1),{stdio:"inherit"});p.on("exit",(code,sig)=>process.exit(code??(sig?128:1)));});`;

function sbpl(text: string) { return `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`; }
/** The macOS profile: writes only to the workspace and temporary directories, credentials unreadable. */
export function darwinProfile(input: { workspace: string; home: string; network: ShellNetwork; proxyPort?: number; readOnly: string[] }): string {
  const writable = [input.workspace, "/private/tmp", "/private/var/folders", "/dev"];
  const lines = ["(version 1)", "(allow default)",
    `(deny file-write* (require-all ${writable.map((path) => `(require-not (subpath ${sbpl(path)}))`).join(" ")}))`,
    ...input.readOnly.map((path) => `(deny file-write* (literal ${sbpl(path)}))`),
    `(deny file-read* file-write* ${CREDENTIAL_PATHS.map((relative) => `(subpath ${sbpl(join(input.home, relative))})`).join(" ")})`,
    "(deny process-info* (target others))"];
  if (input.network.mode === "off") lines.push("(deny network-outbound (remote ip))", "(deny network-bind (local ip))");
  if (input.network.mode === "allow") lines.push("(deny network-outbound (remote ip))", `(allow network-outbound (remote ip ${sbpl(`localhost:${input.proxyPort}`)}))`, "(deny network-bind (local ip))");
  return lines.join("\n");
}

function proxyVariables(url: string): NodeJS.ProcessEnv {
  return { HTTP_PROXY: url, HTTPS_PROXY: url, http_proxy: url, https_proxy: url, ALL_PROXY: url, all_proxy: url, NO_PROXY: "", no_proxy: "" };
}

interface Proxy { socketPath?: string; innerPort: number; close(): Promise<void> }
/**
 * An HTTP proxy that only reaches allowed hosts: CONNECT for HTTPS (the
 * command's own TLS, so nothing is decrypted here) and absolute-URI requests
 * for plain HTTP. Only ports 80 and 443. On Linux it listens on a Unix socket
 * bound into the sandbox; on macOS on a loopback port the profile admits.
 */
async function startProxy(hosts: string[], unixSocket: boolean): Promise<Proxy> {
  const sockets = new Set<Socket>();
  const refuse = (socket: Socket, why: string) => { socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nopencrowd sandbox: ${why}\n`); };
  const server: Server = createServer((request, response) => {
    let url: URL;
    try { url = new URL(request.url ?? ""); } catch { response.writeHead(400).end("opencrowd sandbox: absolute URL required\n"); return; }
    if (url.protocol !== "http:" || !hostAllowed(url.hostname, hosts) || !["", "80"].includes(url.port)) {
      response.writeHead(403, { "content-type": "text/plain" }).end(`opencrowd sandbox: ${url.hostname} is not on the network allowlist\n`); return;
    }
    const headers = Object.fromEntries(Object.entries(request.headers).filter(([key]) => !/^proxy-/i.test(key)));
    const upstream = httpRequest({ host: url.hostname, port: 80, method: request.method, path: `${url.pathname}${url.search}`, headers }, (reply) => {
      response.writeHead(reply.statusCode ?? 502, reply.headers);
      reply.pipe(response);
    });
    upstream.on("error", () => response.destroy());
    request.pipe(upstream);
  });
  server.on("connect", (request, client: Socket) => {
    sockets.add(client);
    const [host, port] = String(request.url).split(":");
    if (!hostAllowed(host, hosts) || port !== "443") { refuse(client, `${host}:${port} is not on the network allowlist`); return; }
    const upstream = connect(443, host, () => { client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); upstream.pipe(client); client.pipe(upstream); });
    sockets.add(upstream);
    upstream.on("error", () => client.destroy()); client.on("error", () => upstream.destroy());
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  const close = () => new Promise<void>((done) => { for (const socket of sockets) socket.destroy(); server.close(() => done()); });
  if (unixSocket) {
    const dir = await mkdtemp(join(tmpdir(), "opencrowd-proxy-")), socketPath = join(dir, "proxy.sock");
    await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(socketPath, done); });
    // Any free number does: the port is on the sandbox's own loopback.
    return { socketPath, innerPort: 3128, close: async () => { await close(); await rm(dir, { recursive: true, force: true }); } };
  }
  await new Promise<void>((done, fail) => { server.once("error", fail); server.listen(0, "127.0.0.1", done); });
  return { innerPort: (server.address() as { port: number }).port, close };
}

/**
 * Whether the sandbox can run here, checked once per process and network
 * mode with the same kind of invocation a command gets: bubblewrap with its
 * own /proc (and network namespace), or the real macOS profile. The reason it
 * cannot is what the ledger and `opencrowd doctor` report.
 */
const probes = new Map<string, Promise<string | undefined>>();
export function sandboxUnavailable(settings: LocalSandboxSettings = { network: { mode: "open" } }, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const key = `${platform}:${settings.network.mode}`;
  let probe = probes.get(key);
  if (!probe) {
    probe = new Promise((done) => {
      const isolated = settings.network.mode !== "open";
      const [program, args] = platform === "linux"
        ? ["bwrap", ["--die-with-parent", "--unshare-pid", ...(isolated ? ["--unshare-net"] : []), "--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/run", "/bin/true"]]
        : platform === "darwin"
          ? ["/usr/bin/sandbox-exec", ["-p", darwinProfile({ workspace: tmpdir(), home: homedir(), network: settings.network, proxyPort: 3128, readOnly: [] }), "/usr/bin/true"]]
          : ["", []];
      if (!program) { done(`not supported on ${platform}`); return; }
      let stderr = "";
      const child = spawn(program, args as string[], { stdio: ["ignore", "ignore", "pipe"] });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", (error) => done(`${program} is not available (${error.message})${platform === "linux" ? "; install bubblewrap" : ""}`));
      child.on("exit", (code) => done(code === 0 ? undefined : `${program} cannot create a sandbox here: ${stderr.trim().slice(0, 300) || `exit ${code}`}`));
    });
    probes.set(key, probe);
  }
  return probe;
}
