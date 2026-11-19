// The storage time: with keep=<hours>, an envelope still stored that long after
// it was stored goes, read or not. Runs on the self-hosted relay with a stand-in
// clock; the sweep fires due alarms.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { appsFrom } from "../src/apps.js";
import { DEFAULT_LIMITS } from "../src/core.js";
import { createRelay } from "../src/node/server.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const APP = "01a1601b-fa85-7d58-b2a2-1416e0a6b054";

function envelope(direction, sequence, size = 64) {
  const bytes = new Uint8Array(size);
  bytes[0] = 1;
  bytes[1] = direction;
  new DataView(bytes.buffer).setBigUint64(2, BigInt(sequence));
  bytes.fill(0xcd, 10);
  return bytes;
}

/** A mailbox of APP on a relay configured with `options`, sharing `clock` and `database`. */
function setup(options = "", { clock = { now: 1_000_000_000 }, database, token, mailbox } = {}) {
  const relay = createRelay({ apps: `${APP}=app${options}`, database, now: () => clock.now });
  token ??= randomBytes(32);
  mailbox ??= randomBytes(16).toString("hex");
  const at = (path, { method = "GET", body } = {}) =>
    relay.fetch(
      new Request(`http://relay.invalid/v1/${APP}/mailbox/${mailbox}${path}`, {
        method,
        body,
        headers: { Authorization: `Bearer ${token.toString("base64url")}` },
      }),
    );
  const tokenDigest = createHash("sha256").update(token).digest("hex");
  const claim = () => at("", { method: "PUT", body: JSON.stringify({ tokenDigest }) });
  const put = (s, direction = 1) =>
    at(`/${direction === 1 ? "p2c" : "c2p"}/${s}`, { method: "PUT", body: envelope(direction, s) });
  const storage = relay.database.storage(`${APP}/${mailbox}`);
  return { relay, at, claim, put, clock, storage, token, mailbox };
}

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

/** What is stored, without fetching (a fetch starts the read time). */
async function waiting(storage, direction = "p2c") {
  const keys = [...(await storage.list({ prefix: `e:${direction}:` })).keys()];
  return keys.map((k) => Number(k.split(":")[2]));
}

test("The storage time is off unless the app sets keep=<hours>, 1 to 8760", () => {
  assert.equal(DEFAULT_LIMITS.keepMilliseconds, null);
  assert.equal(appsFrom(APP)[APP].limits.keepMilliseconds, null);
  assert.equal(appsFrom(`${APP};keep=72`)[APP].limits.keepMilliseconds, 72 * HOUR);
  assert.equal(appsFrom(`${APP};keep=8760`)[APP].limits.keepMilliseconds, 365 * DAY);
  const bad = ["keep", "keep=", "keep=0", "keep=01", "keep=-1", "keep=1.5", "keep=8761", "keep=1;keep=2"];
  for (const option of bad) {
    assert.throws(() => appsFrom(`${APP};${option}`), /RELAY_APPS/, option);
  }
});

test("Without keep, an envelope nobody reads stays until the mailbox goes idle", async () => {
  const { relay, claim, put, clock, storage } = setup();
  await claim();
  await put(1);
  clock.now += 29 * DAY;
  await relay.sweep();
  assert.deepEqual(await waiting(storage), [1]);
  // Dated all the same, should the app get a storage time later.
  assert.equal((await storage.get("meta")).stored.p2c.length, 1);
  relay.close();
});

test("With keep, an envelope nobody read goes its storage time after it was stored", async () => {
  const { relay, claim, put, clock, storage } = setup(";keep=1");
  await claim();
  const start = clock.now;
  await put(1);
  assert.equal(await storage.getAlarm(), start + HOUR);
  clock.now = start + 10 * MINUTE;
  await put(2);
  clock.now = start + HOUR - 1;
  await relay.sweep();
  assert.deepEqual(await waiting(storage), [1, 2]);
  clock.now = start + HOUR;
  await relay.sweep();
  assert.deepEqual(await waiting(storage), [2]);
  assert.equal(await storage.getAlarm(), start + 10 * MINUTE + HOUR);
  clock.now = start + 10 * MINUTE + HOUR;
  await relay.sweep();
  assert.deepEqual(await waiting(storage), []);
  const meta = await storage.get("meta");
  assert.equal(meta.bytes, 0);
  assert.equal(meta.count.p2c, 0);
  assert.deepEqual(meta.stored.p2c, []);
  assert.equal(await storage.getAlarm(), meta.idle);
  // Gone, as if pruned: the sequence goes on.
  assert.equal((await put(2)).status, 409);
  assert.equal((await put(3)).status, 201);
  relay.close();
});

test("Envelopes stored close together share the first one's time, so none stays longer", async () => {
  const { relay, claim, put, clock, storage } = setup(";keep=24");
  await claim();
  const start = clock.now;
  await put(1);
  clock.now = start + 30 * MINUTE;
  await put(2);
  clock.now = start + 61 * MINUTE;
  await put(3);
  assert.deepEqual((await storage.get("meta")).stored.p2c, [
    ["2", start],
    ["3", start + 61 * MINUTE],
  ]);
  clock.now = start + DAY;
  await relay.sweep();
  assert.deepEqual(await waiting(storage), [3]);
  relay.close();
});

test("The storage time applies to read envelopes too, whichever deadline comes first", async () => {
  const { relay, at, claim, put, clock, storage } = setup(";keep=2");
  await claim();
  await put(1);
  assert.deepEqual(await sequences(await at("/p2c?after=0")), [1]);
  clock.now += 2 * HOUR;
  await relay.sweep();
  assert.deepEqual(await waiting(storage), []);
  const meta = await storage.get("meta");
  assert.deepEqual(meta.read.p2c, []);
  assert.deepEqual(meta.stored.p2c, []);
  relay.close();
});

test("Pruning drops the dates with the envelopes; each direction keeps its own", async () => {
  const { relay, at, claim, put, clock, storage } = setup(";keep=1");
  await claim();
  const start = clock.now;
  await put(1);
  clock.now += 10 * MINUTE;
  await put(1, 2);
  assert.equal((await at("/p2c?through=1", { method: "DELETE" })).status, 204);
  const meta = await storage.get("meta");
  assert.deepEqual(meta.stored.p2c, []);
  assert.deepEqual(meta.stored.c2p, [["1", start + 10 * MINUTE]]);
  // Pruning leaves the alarm where it was: it finds nothing due and moves on.
  assert.equal(await storage.getAlarm(), start + HOUR);
  clock.now = start + HOUR;
  await relay.sweep();
  assert.deepEqual(await waiting(storage, "c2p"), [1]);
  assert.equal(await storage.getAlarm(), start + 10 * MINUTE + HOUR);
  clock.now = start + 10 * MINUTE + HOUR;
  await relay.sweep();
  assert.deepEqual(await waiting(storage, "c2p"), []);
  relay.close();
});

test("A direction keeps at most 64 dates; the oldest merge, keeping the earlier time", async () => {
  const { relay, claim, put, clock, storage } = setup(";envelopes=1024;keep=8760");
  await claim();
  const start = clock.now;
  for (let s = 1; s <= 70; s += 1) {
    assert.equal((await put(s)).status, 201);
    clock.now += 2 * HOUR;
  }
  const marks = (await storage.get("meta")).stored.p2c;
  assert.equal(marks.length, 64);
  assert.deepEqual(marks[0], ["7", start]);
  assert.deepEqual(marks.at(-1), ["70", start + 69 * 2 * HOUR]);
  relay.close();
});

test("Turning keep on dates what was already waiting from that moment, and off again stops it", async () => {
  const directory = mkdtempSync(join(tmpdir(), "zerobyte-keep-"));
  const database = join(directory, "relay.sqlite");
  const clock = { now: 1_000_000_000 };
  try {
    const off = setup("", { clock, database });
    await off.claim();
    await off.put(1);
    // As stored before dates existed.
    const meta = await off.storage.get("meta");
    delete meta.stored;
    await off.storage.put("meta", meta);
    off.relay.close();

    clock.now += 3 * DAY;
    const on = setup(";keep=1", { clock, database, token: off.token, mailbox: off.mailbox });
    assert.equal((await on.at("/p2c", { method: "HEAD" })).status, 200);
    const settled = await on.storage.get("meta");
    assert.equal(settled.keep, HOUR);
    assert.deepEqual(settled.stored.p2c, [["1", clock.now]]);
    assert.equal(await on.storage.getAlarm(), clock.now + HOUR);
    await on.put(2);
    on.relay.close();

    const again = setup("", { clock, database, token: off.token, mailbox: off.mailbox });
    assert.equal((await again.at("/p2c", { method: "HEAD" })).status, 200);
    const idle = (await again.storage.get("meta")).idle;
    assert.equal(await again.storage.getAlarm(), idle);
    clock.now += 2 * HOUR;
    await again.relay.sweep();
    assert.deepEqual(await waiting(again.storage), [1, 2]);
    again.relay.close();

    const later = setup(";keep=1", { clock, database, token: off.token, mailbox: off.mailbox });
    assert.equal((await later.claim()).status, 204);
    // The dates were kept while keep was off: both are long due.
    await later.relay.sweep();
    assert.deepEqual(await waiting(later.storage), []);
    later.relay.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("A 1.2.0 mailbox, without an idle deadline in meta, keeps the one in its alarm", async () => {
  const { relay, at, claim, put, clock, storage } = setup(";keep=1");
  await claim();
  await put(1);
  const meta = await storage.get("meta");
  const idle = meta.idle;
  delete meta.idle;
  delete meta.stored;
  delete meta.keep;
  await storage.put("meta", meta);
  await storage.setAlarm(idle);

  clock.now += 10 * MINUTE;
  assert.equal((await at("/p2c", { method: "HEAD" })).status, 200);
  const settled = await storage.get("meta");
  assert.equal(settled.idle, idle);
  assert.equal(await storage.getAlarm(), clock.now + HOUR);
  clock.now += HOUR;
  await relay.sweep();
  assert.deepEqual(await waiting(storage), []);
  assert.equal(await storage.getAlarm(), idle);
  relay.close();
});
