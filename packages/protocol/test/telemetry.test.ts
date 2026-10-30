import { expect, it } from "vitest";
import { captureDetail } from "../src/telemetry.js";
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
