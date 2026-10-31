import { expect, it, vi } from "vitest";
import { deadline, DeadlineExceeded, withDeadline } from "../src/deadlines.js";

it("stops waiting on work that ignores every form of cancellation", async () => {
  // The case this exists for: a promise that will never settle and has no
  // signal to abort. Run 47a629fc's probes were effectively this.
  vi.useFakeTimers();
  try {
    const settled = withDeadline(() => new Promise<string>(() => undefined), 10_000, "probe of https://quiet.example")
      .then(() => undefined, (error: unknown) => error);
    let outcome: unknown = "still waiting";
    void settled.then((value) => { outcome = value; });
    await vi.advanceTimersByTimeAsync(9_999);
    expect(outcome).toBe("still waiting");
    await vi.advanceTimersByTimeAsync(2);
    const error = await settled;
    expect(error).toBeInstanceOf(DeadlineExceeded);
    expect((error as DeadlineExceeded).stage).toBe("probe of https://quiet.example");
    expect((error as Error).message).toBe("probe of https://quiet.example did not finish within 10s");
  } finally { vi.useRealTimers(); }
});

it("returns the work's own answer when it beats the deadline, and its own failure", async () => {
  await expect(withDeadline(async () => "answer", 50_000, "read")).resolves.toBe("answer");
  await expect(withDeadline(async () => { throw new Error("HTTP 503"); }, 50_000, "read")).rejects.toThrow("HTTP 503");
});

it("swallows the abandoned work's later rejection instead of crashing the process", async () => {
  const unhandled = vi.fn();
  process.on("unhandledRejection", unhandled);
  try {
    let fail!: (error: Error) => void;
    const waiting = withDeadline(() => new Promise<void>((_resolve, reject) => { fail = reject; }), 5, "slow read");
    await expect(waiting).rejects.toBeInstanceOf(DeadlineExceeded);
    fail(new Error("the socket closed long after nobody was listening"));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(unhandled).not.toHaveBeenCalled();
  } finally { process.off("unhandledRejection", unhandled); }
});

it("shares one budget across a sequence, so a sweep cannot cost the sum of its parts", () => {
  let now = 1_000;
  const budget = deadline(60_000, () => now);
  expect(budget.slice(15_000)).toBe(15_000);
  now += 50_000;
  expect(budget.remaining()).toBe(10_000);
  expect(budget.slice(15_000)).toBe(10_000);
  now += 20_000;
  expect(budget.expired()).toBe(true);
  expect(budget.remaining()).toBe(0);
  expect(budget.slice(15_000)).toBe(0);
});
