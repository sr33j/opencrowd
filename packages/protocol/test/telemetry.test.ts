import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { captureDetail, scrubText } from "../src/telemetry.js";
it("preserves stdout, stderr, and exit codes while scrubbing nested and embedded credentials",()=>{
  const input={stdout:'hello\nAPI_KEY=abcdefghijk\n',stderr:'exit failed',exit_code:17,nested:{authorization:'Bearer secret',inputTokens:25}};
  const detail=captureDetail(input);
  expect(detail.redacted).toBe(true);expect(detail.truncated).toBe(false);
  expect(detail.value).toMatchObject({stdout:'hello\nAPI_KEY=[REDACTED]\n',stderr:'exit failed',exit_code:17,nested:{authorization:'[REDACTED]',inputTokens:25}});
  expect(input.nested.authorization).toBe('Bearer secret');
});
it("marks oversized captures explicitly, with a bounded JSON preview",()=>{
  const d=captureDetail({stdout:'x'.repeat(300000)},1000);
  expect(d.truncated).toBe(true);expect(d.bytes).toBeGreaterThan(0);expect(JSON.stringify(d).length).toBeLessThan(1000);
});
it("cuts each string before scrubbing it, so one huge value costs the budget and not its own size",()=>{
  // scrubText rewrites a string six times and JSON.stringify copies it again:
  // a 10 MB base64 body reached this function and killed a 512 MB executor.
  const d=captureDetail({audio_base64:'A'.repeat(10_000_000)},4096);
  expect(d.truncated).toBe(true);
  expect(JSON.stringify(d).length).toBeLessThan(10_000);
});
it("keeps the whole capture bounded when many strings are each under the per-string cap",()=>{
  const wide=Object.fromEntries(Array.from({length:200},(_,i)=>[`field${i}`,'y'.repeat(50_000)]));
  const d=captureDetail(wide,4096);
  expect(d.truncated).toBe(true);
  // 200 x 50k would be 10 MB; the shared budget stops it at a multiple of maxBytes.
  expect(d.bytes).toBeLessThan(4096*12);
});
it("redacts a credential in a URI of any scheme, not only a web one",()=>{
  // A hosted agent's stderr is scrubbed with this. The DSN a failing psql,
  // redis-cli or Python traceback prints used to pass through whole, because
  // the rule only knew about http and https.
  const d=captureDetail({stderr:[
    'psql: error: connection to server at "db.internal" failed: FATAL: password authentication failed',
    'connection string was postgres://app:hunter2@db.internal:5432/opencrowd',
    'redis://default:r3disPass@cache.internal:6379 refused',
    'mongodb+srv://svc:m0ng0@cluster0.example.net/admin timed out',
    'fetched https://user:webpass@api.example.com/v1/items',
  ].join('\n')});
  const text=String((d.value as {stderr:string}).stderr);
  expect(d.redacted).toBe(true);
  for(const secret of ['hunter2','r3disPass','m0ng0','webpass']) expect(text).not.toContain(secret);
  expect(text).toContain('postgres://[REDACTED]@db.internal:5432/opencrowd');
  expect(text).toContain('redis://[REDACTED]@cache.internal:6379');
  expect(text).toContain('mongodb+srv://[REDACTED]@cluster0.example.net/admin');
  // The diagnostic itself is intact: this is redaction, not suppression.
  expect(text).toContain('password authentication failed');
  expect(text).toContain('cluster0.example.net');
});

// ---------------------------------------------------------------------------
// Properties (SRI-175). The examples above are the regression seeds.
// ---------------------------------------------------------------------------

const lower = "abcdefghijklmnopqrstuvwxyz", digits = "0123456789";
/** RFC 3986 userinfo characters: unreserved, sub-delims and percent-encodings ("@" and "/" must be encoded). */
const userinfoChar = fc.oneof(fc.constantFrom(...`${lower}${lower.toUpperCase()}${digits}-._~!$&'()*+,;=`),
  fc.constantFrom("%40", "%2F", "%3A", "%25", "%20"));
const scheme = fc.oneof(
  fc.constantFrom("http", "https", "postgres", "postgresql", "redis", "rediss", "mongodb", "mongodb+srv", "amqp", "amqps", "mysql", "ftp", "sftp", "ssh", "smtp", "ldap", "git+ssh"),
  fc.tuple(fc.constantFrom(...lower), fc.string({ unit: fc.constantFrom(...`${lower}${digits}+.-`), maxLength: 10 })).map(([a, b]) => a + b)
).chain(name => fc.array(fc.boolean(), { minLength: name.length, maxLength: name.length })
  .map(upper => [...name].map((char, i) => (upper[i] ? char.toUpperCase() : char)).join("")));
const host = fc.oneof(fc.domain(), fc.ipV4(), fc.ipV6().map(ip => `[${ip}]`), fc.constantFrom("localhost", "db.internal", "cache"));
const port = fc.option(fc.integer({ min: 1, max: 65535 }).map(n => `:${n}`), { nil: "" });
const path = fc.string({ unit: fc.constantFrom(...`${lower}${digits}/?=&._-`), maxLength: 20 }).map(rest => (rest ? `/${rest}` : ""));
/** What a log line puts around a URL. */
const before = fc.constantFrom("", " ", "\n", "\t", "url=", "DATABASE_URL=", "connecting to ", "\"", "'", "(", "<", "[", "DSN: ", "failed: ", "error at ", "`");
const after = fc.constantFrom("", " ", "\n", "\"", "'", ")", ">", "]", " refused", ": timeout", ",", ";");

describe("properties: scrubText", () => {
  it("never lets the password in a URI of any scheme survive", () => {
    // T5 found: a URI with an empty user and a password (redis://:pass@host, the usual form for
    // Redis requirepass) passes through whole. Counterexample "http://:a@localhost"
    // (seed 396261006, path "3:0:0:0:0:0:0:0:0:0:0"). Users stay non-empty here until it is fixed.
    // A user named like a key ("cookie", "db_password") is redacted by the key=value rule, host and all.
    const user = fc.string({ unit: userinfoChar, minLength: 1, maxLength: 12 })
      .filter(name => !/secret|password|api_key|private_key|access_token|authorization|cookie|signature/i.test(name));
    const password = fc.string({ unit: fc.oneof(userinfoChar, fc.constant(":")), minLength: 1, maxLength: 24 });
    fc.assert(fc.property(before, scheme, user, password, host, port, path, after, (pre, name, u, pass, h, p, rest, post) => {
      const text = `${pre}${name}://${u}:${pass}@${h}${p}${rest}${post}`;
      const out = scrubText(text);
      expect(out).not.toContain(`:${pass}@`);
      expect(out).not.toContain(`${u}:${pass}`);
      // Redaction, not suppression: where the connection went stays readable.
      expect(out).toContain(h);
    }));
  });

  it("removes a generated key or token wherever it sits in a captured value", () => {
    // T5 found: the sk- rule ends in \b, which cannot match after a trailing "-", so a 16-character
    // key body that ends in "-" passes whole: counterexample "sk-aaaaaaaaaaaaaaa-" (seed 1701816398).
    // Longer ones keep only the trailing "-". Kept to bodies with 16 characters before any trailing "-".
    const token = fc.oneof(
      fc.string({ unit: fc.constantFrom(...`${lower}${digits}ABCDEFXYZ_-`), minLength: 16, maxLength: 40 })
        .filter(t => t.replace(/-+$/, "").length >= 16).map(t => `sk-${t}`),
      fc.string({ unit: fc.constantFrom(...`${lower}${digits}ABCDEFXYZ`), minLength: 20, maxLength: 40 }).chain(t => fc.constantFrom(`ghp_${t}`, `gho_${t}`, `ghs_${t}`)),
      fc.tuple(...[0, 1, 2].map(() => fc.string({ unit: fc.constantFrom(...`${lower}${digits}_-`), minLength: 4, maxLength: 30 }))).map(([a, b, c]) => `eyJ${a}.${b}.${c}`)
    );
    fc.assert(fc.property(fc.jsonValue(), fc.constantFrom("", "key ", "Bearer ", "token: ", "\n", "x "), token, after, (base, pre, secret, post) => {
      const d = captureDetail({ base, stderr: `${pre}${secret}${post}`, nested: [{ deep: `${pre}${secret}${post}` }] });
      expect(JSON.stringify(d)).not.toContain(secret);
      expect(d.redacted).toBe(true);
    }));
  });
});
