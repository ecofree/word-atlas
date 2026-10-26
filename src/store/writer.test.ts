import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import { DatasetWriter, type WriteAccess } from "./writer";

type PendingLock = {
  name: string;
  options: LockOptions;
  callback: (lock: Lock) => unknown;
  status: "queued" | "granted" | "finished" | "aborted";
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  removeAbortListener: () => void;
};

/** Exclusive FIFO locks; abort only cancels requests that have not been granted. */
class FakeLockManager {
  readonly requests: PendingLock[] = [];
  readonly held = new Map<string, PendingLock>();
  readonly deliveries: (() => void)[] = [];
  deferCallbacks = false;
  rejectWith: Error | undefined;

  request(name: string, options: LockOptions, callback: (lock: Lock) => unknown): Promise<unknown> {
    // In particular, signal + ifAvailable is rejected by real browsers.
    assert.equal(options.mode, "exclusive");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.ifAvailable, undefined);
    assert.equal(options.steal, undefined);
    if (this.rejectWith) return Promise.reject(this.rejectWith);

    let resolve!: (value: unknown) => void;
    let reject!: (error: unknown) => void;
    const result = new Promise<unknown>((ok, fail) => { resolve = ok; reject = fail; });
    const request: PendingLock = { name, options, callback, status: "queued", resolve, reject, removeAbortListener: () => {} };
    const abort = () => {
      if (request.status !== "queued") return;
      request.status = "aborted";
      request.removeAbortListener();
      request.reject(new DOMException("Request aborted", "AbortError"));
    };
    request.removeAbortListener = () => options.signal?.removeEventListener("abort", abort);
    options.signal.addEventListener("abort", abort, { once: true });
    this.requests.push(request);
    if (options.signal.aborted) abort();
    else this.grantNext(name);
    return result;
  }

  private grantNext(name: string) {
    if (this.held.has(name)) return;
    const request = this.requests.find((pending) => pending.name === name && pending.status === "queued");
    if (!request) return;
    request.status = "granted";
    request.removeAbortListener();
    this.held.set(name, request);
    const finish = (error?: unknown) => {
      request.status = "finished";
      this.held.delete(name);
      if (error) request.reject(error);
      else request.resolve(undefined);
      this.grantNext(name);
    };
    const deliver = () => {
      void Promise.resolve().then(() => request.callback({ name, mode: "exclusive" })).then(() => finish(), finish);
    };
    if (this.deferCallbacks) this.deliveries.push(deliver);
    else deliver();
  }
}

function fixture(t: TestContext, navigatorValue: object | undefined) {
  const original = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  if (navigatorValue === undefined) Reflect.deleteProperty(globalThis, "navigator");
  else Object.defineProperty(globalThis, "navigator", { configurable: true, value: navigatorValue });
  const writers: DatasetWriter[] = [];
  t.after(async () => {
    writers.forEach((writer) => writer.stop());
    await setImmediate();
    if (original) Object.defineProperty(globalThis, "navigator", original);
    else Reflect.deleteProperty(globalThis, "navigator");
  });
  return () => {
    const events: WriteAccess[] = [];
    const writer = new DatasetWriter((access) => events.push(access));
    writers.push(writer);
    return { writer, events };
  };
}

test("same-dataset writers remain exclusive and queued tabs take over automatically", async (t) => {
  const locks = new FakeLockManager();
  const makeWriter = fixture(t, { locks });
  const first = makeWriter();
  const second = makeWriter();
  const third = makeWriter();
  first.writer.start("shared");
  second.writer.start("shared");
  third.writer.start("shared");
  await setImmediate();
  assert.equal(first.writer.canWrite(), true);
  assert.equal(second.writer.canWrite(), false);
  assert.equal(third.writer.canWrite(), false);
  assert.deepEqual(second.events, ["readonly"]);
  assert.equal(locks.held.size, 1);

  first.writer.stop();
  assert.equal(first.writer.canWrite(), false);
  await setImmediate();
  assert.equal(second.writer.canWrite(), true);
  assert.equal(third.writer.canWrite(), false);
  assert.deepEqual(second.events, ["readonly", "writable"]);

  second.writer.stop();
  await setImmediate();
  assert.equal(third.writer.canWrite(), true);
  assert.equal(locks.held.size, 1);
});

test("different datasets have independent writers and releases", async (t) => {
  const locks = new FakeLockManager();
  const makeWriter = fixture(t, { locks });
  const open = makeWriter();
  const privateAtlas = makeWriter();
  open.writer.start("open");
  privateAtlas.writer.start("private");
  await setImmediate();
  assert.equal(open.writer.canWrite(), true);
  assert.equal(privateAtlas.writer.canWrite(), true);
  assert.equal(locks.held.size, 2);
  assert.notEqual(locks.requests[0].name, locks.requests[1].name);

  open.writer.stop();
  await setImmediate();
  assert.equal(open.writer.canWrite(), false);
  assert.equal(privateAtlas.writer.canWrite(), true);
  assert.equal(locks.held.size, 1);
});

test("stopping a hidden queued tab cancels its request without taking the released lock", async (t) => {
  const locks = new FakeLockManager();
  const makeWriter = fixture(t, { locks });
  const owner = makeWriter();
  const hidden = makeWriter();
  const visible = makeWriter();
  owner.writer.start("shared");
  hidden.writer.start("shared");
  visible.writer.start("shared");
  await setImmediate();
  hidden.writer.stop();
  assert.equal(locks.requests[1].options.signal?.aborted, true);
  owner.writer.stop();
  await setImmediate();

  assert.equal(hidden.writer.canWrite(), false);
  assert.deepEqual(hidden.events, ["readonly"]);
  assert.equal(locks.requests[1].status, "aborted");
  assert.equal(visible.writer.canWrite(), true);
});

test("late grant callbacks from an earlier generation cannot change current ownership", async (t) => {
  const locks = new FakeLockManager();
  locks.deferCallbacks = true;
  const makeWriter = fixture(t, { locks });
  const active = makeWriter();
  active.writer.start("old-dataset");
  active.writer.stop();
  active.writer.start("current-dataset");
  assert.equal(locks.deliveries.length, 2);

  // A grant can already be committed when stop aborts its request. Deliver that
  // old callback after the new dataset has acquired ownership.
  locks.deliveries[1]();
  await setImmediate();
  assert.equal(active.writer.canWrite(), true);
  locks.deliveries[0]();
  await setImmediate();
  assert.equal(active.writer.canWrite(), true);
  assert.deepEqual(active.events, ["readonly", "readonly", "writable"]);
  assert.equal(locks.held.has("word-atlas:writer:old-dataset"), false);

  locks.deferCallbacks = false;
  const next = makeWriter();
  next.writer.start("current-dataset");
  await setImmediate();
  assert.equal(next.writer.canWrite(), false);
  active.writer.stop();
  await setImmediate();
  assert.equal(next.writer.canWrite(), true);
});

test("aborting an old queued request cannot mark a restarted writer unavailable", async (t) => {
  const locks = new FakeLockManager();
  const makeWriter = fixture(t, { locks });
  const owner = makeWriter();
  const changing = makeWriter();
  owner.writer.start("occupied");
  await setImmediate();
  changing.writer.start("occupied");
  changing.writer.start("available");
  await setImmediate();

  assert.equal(owner.writer.canWrite(), true);
  assert.equal(changing.writer.canWrite(), true);
  assert.deepEqual(changing.events, ["readonly", "readonly", "writable"]);
  assert.equal(locks.requests[1].status, "aborted");
});

test("an absent Web Locks API keeps progress unavailable", async (t) => {
  for (const navigatorValue of [undefined, {}]) {
    await t.test(navigatorValue ? "navigator without locks" : "no navigator", async (child) => {
      const makeWriter = fixture(child, navigatorValue);
      const current = makeWriter();
      current.writer.start("open");
      await setImmediate();
      assert.equal(current.writer.canWrite(), false);
      assert.deepEqual(current.events, ["unavailable"]);
    });
  }
});

test("a rejected lock request fails closed and can be explicitly retried", async (t) => {
  const locks = new FakeLockManager();
  locks.rejectWith = new DOMException("Lock access denied", "SecurityError");
  const makeWriter = fixture(t, { locks });
  const current = makeWriter();
  current.writer.start("open");
  await setImmediate();
  assert.equal(current.writer.canWrite(), false);
  assert.deepEqual(current.events, ["readonly", "unavailable"]);
  assert.equal(locks.held.size, 0);

  locks.rejectWith = undefined;
  current.writer.start("open");
  await setImmediate();
  assert.equal(current.writer.canWrite(), true);
  assert.deepEqual(current.events, ["readonly", "unavailable", "readonly", "writable"]);
});
