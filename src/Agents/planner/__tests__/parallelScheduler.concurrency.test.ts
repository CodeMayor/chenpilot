/**
 * Concurrency tests for workflow state updates.
 *
 * WorkflowConcurrencyEngine arbitrates recovery vs intervention actors
 * competing to perform a workflow's side effect exactly once. These tests
 * pin the single-winner semantics under interleaved async execution.
 */
import { WorkflowConcurrencyEngine } from "../parallelScheduler";

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("WorkflowConcurrencyEngine", () => {
  let engine: WorkflowConcurrencyEngine;

  beforeEach(() => {
    engine = new WorkflowConcurrencyEngine();
  });

  it("allows exactly one winner when recovery and intervention race", async () => {
    const gate = deferred();
    const recoveryEffect = jest.fn(() => gate.promise);
    const interventionEffect = jest.fn(() => Promise.resolve());

    const recoveryAttempt = engine.executeAttempt(
      "wf-1",
      "recovery",
      recoveryEffect
    );
    const interventionAttempt = engine.executeAttempt(
      "wf-1",
      "intervention",
      interventionEffect
    );
    gate.resolve();
    const [recoveryResult, interventionResult] = await Promise.all([
      recoveryAttempt,
      interventionAttempt,
    ]);

    // The recovery attempt claimed the workflow first; its side effect is
    // still in flight while the intervention attempt was rejected outright.
    expect(recoveryResult).toBe(true);
    expect(interventionResult).toBe(false);
    expect(recoveryEffect).toHaveBeenCalledTimes(1);
    expect(interventionEffect).not.toHaveBeenCalled();
  });

  it("runs the side effect only once even when attempts interleave mid-flight", async () => {
    const gate = deferred();
    let sideEffectCalls = 0;
    const sideEffect = jest.fn(async () => {
      sideEffectCalls += 1;
      await gate.promise;
    });

    const first = engine.executeAttempt("wf-2", "recovery", sideEffect);
    const second = engine.executeAttempt("wf-2", "intervention", sideEffect);
    const third = engine.executeAttempt("wf-2", "recovery", sideEffect);

    gate.resolve();
    const results = await Promise.all([first, second, third]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(sideEffectCalls).toBe(1);
  });

  it("rejects further attempts after a successful claim", async () => {
    const sideEffect = jest.fn().mockResolvedValue(undefined);

    await expect(
      engine.executeAttempt("wf-3", "recovery", sideEffect)
    ).resolves.toBe(true);
    await expect(
      engine.executeAttempt("wf-3", "intervention", sideEffect)
    ).resolves.toBe(false);
    await expect(
      engine.executeAttempt("wf-3", "recovery", sideEffect)
    ).resolves.toBe(false);
    expect(sideEffect).toHaveBeenCalledTimes(1);
  });

  it("tracks independent state per workflow id", async () => {
    const effectA = jest.fn().mockResolvedValue(undefined);
    const effectB = jest.fn().mockResolvedValue(undefined);

    await expect(
      engine.executeAttempt("wf-a", "recovery", effectA)
    ).resolves.toBe(true);
    await expect(
      engine.executeAttempt("wf-b", "intervention", effectB)
    ).resolves.toBe(true);
    expect(effectA).toHaveBeenCalledTimes(1);
    expect(effectB).toHaveBeenCalledTimes(1);
  });

  it("releases the claim when the side effect fails so a retry can succeed", async () => {
    const failing = jest.fn().mockRejectedValue(new Error("boom"));
    const succeeding = jest.fn().mockResolvedValue(undefined);

    await expect(
      engine.executeAttempt("wf-4", "recovery", failing)
    ).rejects.toThrow("boom");

    // The failed attempt must not leave the workflow stuck in a terminal
    // state: a subsequent attempt by either actor may retry.
    await expect(
      engine.executeAttempt("wf-4", "intervention", succeeding)
    ).resolves.toBe(true);
    expect(succeeding).toHaveBeenCalledTimes(1);
  });

  it("does not run the side effect for a rejected concurrent attempt", async () => {
    const winnerEffect = jest.fn().mockResolvedValue(undefined);
    const loserEffect = jest.fn().mockResolvedValue(undefined);

    const results = await Promise.all([
      engine.executeAttempt("wf-5", "recovery", winnerEffect),
      engine.executeAttempt("wf-5", "intervention", loserEffect),
    ]);

    const winners = results.filter(Boolean);
    expect(winners).toHaveLength(1);
    const totalEffectCalls =
      winnerEffect.mock.calls.length + loserEffect.mock.calls.length;
    expect(totalEffectCalls).toBe(1);
  });
});
