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
  expect(d.truncated).toBe(true);expect(d.bytes).toBeGreaterThan(300000);expect(JSON.stringify(d).length).toBeLessThan(1000);
});
