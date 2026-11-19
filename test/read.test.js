// The read time: an envelope a fetch has returned goes when the reader prunes
// it, and at the latest when its read time ends, pruned or not. Runs on the
// self-hosted relay with a stand-in clock; the sweep fires due alarms.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { test } from "node:test";

import { appsFrom } from "../src/apps.js";
import { DEFAULT_LIMITS } from "../src/core.js";
import { createRelay } from "../src/node/server.js";

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const PLAIN = "01a1601b-fa85-7d58-b2a2-1416e0a6b054";
const INSTANT = "019a2b3c-4d5e-7f60-8172-93a4b5c6d7e8";
const HOURLY = "019a2b3c-4d5e-7f60-8172-93a4b5c6d7e9";
const RELAY_APPS = `${PLAIN}=plain,${INSTANT}=instant;read=0,${HOURLY}=hourly;read=60`;

function envelope(direction, sequence, size = 64) {
  const bytes = new Uint8Array(size);
  bytes[0] = 1;
  bytes[1] = direction;
  new DataView(bytes.buffer).setBigUint64(2, BigInt(sequence));
  bytes.fill(0xcd, 10);
  return bytes;
}

/** A relay with its own clock, and one claimed-or-not mailbox of `app`. */
function setup(app = PLAIN) {
  const clock = { now: 1_000_000_000 };
  const relay = createRelay({ apps: RELAY_APPS, now: () => clock.now });
  const token = randomBytes(32);
  const mailbox = randomBytes(16).toString("hex");
  const at = (path, { method = "GET", body } = {}) =>
    relay.fetch(
      new Request(`http://relay.invalid/v1/${app}/mailbox/${mailbox}${path}`, {
        method,
        body,
        headers: { Authorization: `Bearer ${token.toString("base64url")}` },
      }),
    );
  const tokenDigest = createHash("sha256").update(token).digest("hex");
  const claim = () => at("", { method: "PUT", body: JSON.stringify({ tokenDigest }) });
  const put = (s) => at(`/p2c/${s}`, { method: "PUT", body: envelope(1, s) });
  return { relay, at, claim, put, clock, storage: relay.database.storage(`${app}/${mailbox}`) };
}

/** The sequence numbers a fetch returned. */
async function sequences(response) {
  assert.equal(response.status, 200);
  const view = new DataView(await response.arrayBuffer());
  const out = [];
  let offset = 4;
  for (let i = 0; i < view.getUint32(0); i += 1) {
    out.push(Number(view.getBigUint64(offset + 4 + 2)));
    offset += 4 + view.getUint32(offset);
  }
  return out;
}

test("The read time is a day unless the app sets read=<minutes>; 0 is allowed", () => {
  assert.equal(DEFAULT_LIMITS.readMilliseconds, DAY);
  const apps = appsFrom(RELAY_APPS);
  assert.equal(apps[PLAIN].limits.readMilliseconds, DAY);
  assert.equal(apps[INSTANT].limits.readMilliseconds, 0);
  assert.equal(apps[HOURLY].limits.readMilliseconds, 60 * MINUTE);
  const bad = ["read", "read=", "read=00", "read=-1", "read=1.5", "read=1441", "read=0;read=5"];
  for (const option of bad) {
    assert.throws(() => appsFrom(`${PLAIN};${option}`), /RELAY_APPS/, option);
  }
});

test("An envelope a fetch returned and nobody pruned goes a day after that fetch", async () => {
  const { relay, at, claim, put, clock, storage } = setup();
  await claim();
  for (let s = 1; s <= 3; s += 1) assert.equal((await put(s)).status, 201);
  const fetchedAt = clock.now;
  assert.deepEqual(await sequences(await at("/p2c?after=0")), [1, 2, 3]);
  assert.equal(await storage.getAlarm(), fetchedAt + DAY);

  // Fetching again does not move the deadline.
  clock.now = fetchedAt + DAY - 1;
  assert.deepEqual(await sequences(await at("/p2c?after=0")), [1, 2, 3]);
  await relay.sweep();
  assert.deepEqual(await sequences(await at("/p2c?after=0")), [1, 2, 3]);

  clock.now = fetchedAt + DAY;
  await relay.sweep();
  assert.deepEqual(await sequences(await at("/p2c?after=0")), []);
  const meta = await storage.get("meta");
  assert.equal(meta.bytes, 0);
  assert.deepEqual(meta.count, { p2c: 0, c2p: 0 });
  assert.deepEqual(meta.read.p2c, []);
  // The mailbox stays, waiting for its idle deadline, and the sequence survives.
  assert.equal(await storage.getAlarm(), meta.idle);
  assert.equal((await claim()).status, 204);
  assert.equal((await at("/p2c", { method: "HEAD" })).headers.get("X-Relay-Last"), "3");
  assert.equal((await put(3)).status, 409);
  relay.close();
});

test("Pruning deletes at once and clears the deadline", async () => {
  const { relay, at, claim, put, clock, storage } = setup();
  await claim();
  await put(1);
  await put(2);
  assert.deepEqual(await sequences(await at("/p2c?after=0")), [1, 2]);
  assert.equal((await at("/p2c?through=2", { method: "DELETE" })).status, 204);
  const meta = await storage.get("meta");
  assert.deepEqual(meta.read.p2c, []);
  assert.equal(meta.bytes, 0);
  // The alarm set for that deadline finds nothing due and waits for the idle one.
  clock.now += DAY;
  await relay.sweep();
  assert.equal(await storage.getAlarm(), meta.idle);
  assert.equal((await claim()).status, 204);
  relay.close();
});

test("Only the first fetch starts the read time; later envelopes wait for theirs", async () => {
  const { relay, at, claim, put, clock } = setup();
  await claim();
  await put(1);
  await put(2);
  const first = clock.now;
  assert.deepEqual(await sequences(await at("/p2c?after=0")), [1, 2]);
  clock.now = first + DAY / 2;
  await put(3);
  assert.deepEqual(await sequences(await at("/p2c?after=0")), [1, 2, 3]);

  clock.now = first + DAY;
  await relay.sweep();
  assert.deepEqual(await sequences(await at("/p2c?after=0")), [3]);
  clock.now = first + DAY + DAY / 2;
  await relay.sweep();
  assert.deepEqual(await sequences(await at("/p2c?after=0")), []);
  relay.close();
});

test("A fetch covers what the reader says it has, never what is stored after it", async () => {
  const { relay, at, claim, put, clock } = setup();
  await claim();
  await put(1);
  await put(2);
  // `after` past the last envelope: the reader has 1 and 2, 3 does not exist yet.
  assert.deepEqual(await sequences(await at("/p2c?after=9")), []);
  await put(3);
  clock.now += DAY;
  await relay.sweep();
  assert.deepEqual(await sequences(await at("/p2c?after=0")), [3]);
  relay.close();
});

test("Each direction keeps its own deadlines", async () => {
  const { relay, at, claim, put, clock } = setup();
  await claim();
  await put(1);
  assert.equal((await at("/c2p/1", { method: "PUT", body: envelope(2, 1) })).status, 201);
  assert.deepEqual(await sequences(await at("/p2c?after=0")), [1]);
  clock.now += DAY;
  await relay.sweep();
  assert.deepEqual(await sequences(await at("/p2c?after=0")), []);
  assert.deepEqual(await sequences(await at("/c2p?after=0")), [1]);
  relay.close();
});

test("With read=0 the fetch itself deletes what it returns", async () => {
  const { relay, at, claim, put, storage } = setup(INSTANT);
  await claim();
  for (let s = 1; s <= 20; s += 1) assert.equal((await put(s)).status, 201);
  const first = await at("/p2c?after=0");
  assert.equal(first.headers.get("X-Relay-More"), "1");
  assert.equal((await sequences(first)).length, 16);
  let meta = await storage.get("meta");
  assert.equal(meta.count.p2c, 4);
  assert.equal(meta.bytes, 4 * 64);
  const rest = await at("/p2c?after=16");
  assert.equal(rest.headers.get("X-Relay-More"), "0");
  assert.deepEqual(await sequences(rest), [17, 18, 19, 20]);
  assert.deepEqual(await sequences(await at("/p2c?after=0")), []);
  meta = await storage.get("meta");
  assert.equal(meta.bytes, 0);
  assert.equal(meta.read, undefined);
  assert.equal(await storage.getAlarm(), meta.idle);
  assert.equal((await at("/p2c", { method: "HEAD" })).headers.get("X-Relay-Last"), "20");
  relay.close();
});

test("An app's own read time applies: read=60 deletes an hour after the fetch", async () => {
  const { relay, at, claim, put, clock } = setup(HOURLY);
  await claim();
  await put(1);
  assert.deepEqual(await sequences(await at("/p2c?after=0")), [1]);
  clock.now += 60 * MINUTE - 1;
  await relay.sweep();
  assert.deepEqual(await sequences(await at("/p2c?after=0")), [1]);
  clock.now += 1;
  await relay.sweep();
  assert.deepEqual(await sequences(await at("/p2c?after=0")), []);
  relay.close();
});

test("Fetches within a minute share one deadline, and a direction keeps at most 32", async () => {
  const { relay, at, claim, put, clock, storage } = setup();
  await claim();
  const start = clock.now;
  await put(1);
  await sequences(await at("/p2c?after=0"));
  clock.now += 30_000;
  await put(2);
  await sequences(await at("/p2c?after=1"));
  assert.deepEqual((await storage.get("meta")).read.p2c, [["2", start + DAY]]);

  for (let s = 3; s <= 42; s += 1) {
    clock.now += 2 * MINUTE;
    await put(s);
    assert.deepEqual(await sequences(await at(`/p2c?after=${s - 1}`)), [s]);
  }
  const marks = (await storage.get("meta")).read.p2c;
  assert.equal(marks.length, 32);
  // The oldest deadline is kept, so nothing stays past its own.
  assert.equal(marks[0][1], start + DAY);
  assert.deepEqual(marks.at(-1), ["42", clock.now + DAY]);
  for (let i = 1; i < marks.length; i += 1) assert.ok(marks[i][1] > marks[i - 1][1]);

  clock.now += DAY;
  await relay.sweep();
  assert.deepEqual(await sequences(await at("/p2c?after=0")), []);
  relay.close();
});

test("A mailbox from before the read time keeps its idle deadline", async () => {
  const { relay, at, claim, put, clock, storage } = setup();
  await claim();
  await put(1);
  // As stored by 1.2.0: no idle, fetched or read in meta; the alarm is the idle deadline.
  const meta = await storage.get("meta");
  const idle = meta.idle;
  delete meta.idle;
  await storage.put("meta", meta);
  assert.equal(await storage.getAlarm(), idle);

  assert.deepEqual(await sequences(await at("/p2c?after=0")), [1]);
  assert.equal((await storage.get("meta")).idle, idle);
  assert.equal(await storage.getAlarm(), clock.now + DAY);
  clock.now = idle;
  await relay.sweep();
  assert.equal((await at("/p2c")).status, 401);
  relay.close();
});

test("A 1.2.0 alarm without an idle deadline in meta still erases", async () => {
  const { relay, at, claim, put, clock, storage } = setup();
  await claim();
  await put(1);
  const meta = await storage.get("meta");
  const idle = meta.idle;
  delete meta.idle;
  await storage.put("meta", meta);
  clock.now = idle;
  await relay.sweep();
  assert.equal((await at("/p2c")).status, 401);
  relay.close();
});
