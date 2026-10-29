import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { io as client } from "socket.io-client";
import { createApp } from "../server/index.js";
import sharp from "sharp";

const waitFor = async (fn, timeout = 3000) => {
  const deadline = Date.now() + timeout;
  while (!fn()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for game state");
    await new Promise((r) => setTimeout(r, 5));
  }
};

test("profile images are validated and converted to square compressed WebP", async (t) => {
  const server = createApp();
  await new Promise((r) => server.http.listen(0, "127.0.0.1", r));
  const socket = client(`http://127.0.0.1:${server.http.address().port}`);
  t.after(async () => {
    socket.disconnect();
    await server.close();
  });
  await new Promise((r) => socket.once("connect", r));
  const send = (data) =>
    new Promise((resolve) => socket.emit("join", data, resolve));
  const token = randomBytes(32).toString("hex");
  const payload = { name: "Photo player", token, create: true };
  const invalid = await send({
    ...payload,
    image: "data:image/svg+xml;base64,PHN2Zz4=",
  });
  assert.equal(invalid.ok, false);
  const broken = await send({
    ...payload,
    image: "data:image/png;base64,bm90YW5pbWFnZQ==",
  });
  assert.equal(broken.ok, false);
  const jpeg = await sharp({
    create: { width: 240, height: 360, channels: 3, background: "#ff0000" },
  })
    .jpeg()
    .toBuffer();
  let state;
  socket.on("state", (s) => {
    state = s;
  });
  const valid = await send({
    ...payload,
    image: `data:image/jpeg;base64,${jpeg.toString("base64")}`,
  });
  assert.equal(valid.ok, true);
  await waitFor(() => state);
  const image = state.players[0].image;
  assert.ok(image.startsWith("data:image/webp;base64,"));
  const data = Buffer.from(image.split(",")[1], "base64");
  const metadata = await sharp(data).metadata();
  assert.equal(metadata.width, 128);
  assert.equal(metadata.height, 128);
  assert.equal(metadata.format, "webp");
  assert.ok(data.length < 10000);
});

test("real sockets complete a five-player game, reconnect, and keep ballots private", async (t) => {
  let aiAttempts = 0;
  const server = createApp({
    generate: async () => {
      if (++aiAttempts === 1) throw new Error("Temporary provider outage");
      return {
        text: `An artificially eloquent apology ${aiAttempts}.`,
        model: "test-model",
        responseId: "test-completion",
      };
    },
    durations: { selecting: 15 },
  });
  await new Promise((r) => server.http.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.http.address().port}`;
  const clients = [];
  t.after(async () => {
    clients.forEach((c) => c.socket.disconnect());
    await server.close();
  });
  async function connect(token = randomBytes(32).toString("hex")) {
    const socket = client(url, {
      transports: ["websocket"],
      reconnection: false,
    });
    const c = { socket, token, state: null };
    clients.push(c);
    socket.on("state", (s) => {
      c.state = s;
    });
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("connect_error", reject);
    });
    c.send = (event, data = {}) =>
      new Promise((resolve, reject) =>
        socket
          .timeout(2000)
          .emit(event, data, (err, res) => (err ? reject(err) : resolve(res))),
      );
    return c;
  }
  assert.deepEqual(await (await fetch(`${url}/health`)).json(), { ok: true });
  const html = await (await fetch(url)).text();
  assert.match(html, /SLOP OR HUMAN/);
  const host = await connect();
  assert.equal(
    (await host.send("join", { name: "Host", token: host.token, create: true }))
      .ok,
    true,
  );
  const code = host.state.code;
  assert.equal((await host.send("start")).ok, false);
  for (let i = 1; i < 5; i++) {
    const c = await connect();
    assert.equal(
      (await c.send("join", { name: `Human ${i}`, token: c.token, code })).ok,
      true,
    );
  }
  const original = clients[4];
  const playerId = original.state.self;
  original.socket.disconnect();
  const reconnect = await connect(original.token);
  assert.equal(
    (
      await reconnect.send("join", {
        code,
        token: reconnect.token,
        name: "Human 4",
      })
    ).ok,
    true,
  );
  assert.equal(reconnect.state.self, playerId);
  assert.equal(reconnect.state.players.length, 5);
  const active = [host, clients[1], clients[2], clients[3], reconnect];
  assert.equal((await active[1].send("start")).ok, false);
  await host.send("start");
  await waitFor(() => active.every((c) => c.state.phase === "scenario"));
  const writer = active.find((c) => c.state.self === c.state.writer);
  await writer.send("scenario", { text: "A heartfelt lunch apology" });
  await waitFor(() => active.every((c) => c.state.phase === "writing"));
  for (const c of active.filter((c) => c !== writer))
    await c.send("submit", { text: `Human response from ${c.state.self}` });
  assert.equal(writer.state.phase, "writing");
  assert.equal(writer.state.expected, 5);
  assert.equal(writer.state.hasSubmitted, false);
  assert.equal(
    (await writer.send("submit", { text: "The scenario writer plays too." }))
      .ok,
    true,
  );
  await waitFor(() => active.every((c) => c.state.phase === "ai-error"));
  assert.ok(host.state.players.every((p) => p.score === 0));
  assert.equal((await active[1].send("retry-ai")).ok, false);
  assert.equal((await host.send("retry-ai")).ok, true);
  await waitFor(() => active.every((c) => c.state.phase === "voting"));
  for (let group = 1; group <= 2; group++) {
    await waitFor(() =>
      active.every(
        (c) => c.state.phase === "voting" && c.state.votingGroup === group,
      ),
    );
    for (const c of active) {
      assert.ok(c.state.ballot.length >= 3 && c.state.ballot.length <= 4);
      assert.ok(
        c.state.ballot.every((r) => !("author" in r) && !("model" in r)),
      );
      const own = c.state.ballot.find((r) => r.isOwn);
      if (own) assert.equal((await c.send("vote", { id: own.id })).ok, false);
      const ai = c.state.ballot.find((r) =>
        r.text.startsWith("An artificially eloquent apology"),
      );
      assert.equal((await c.send("vote", { id: ai.id })).ok, true);
      assert.equal((await c.send("vote", { id: ai.id })).ok, false);
    }
  }
  await waitFor(() => active.every((c) => c.state.phase === "reveal"));
  assert.ok(host.state.players.every((p) => p.score === 20));
  assert.equal(host.state.responses.length, 7);
  assert.equal(
    new Set(
      host.state.responses.filter((r) => r.author === null).map((r) => r.text),
    ).size,
    2,
  );
  await host.send("leaderboard");
  await host.send("end");
  await waitFor(() => host.state.phase === "final");
  assert.equal(host.state.awards[1].winners.length, 5);
  await host.send("again");
  await waitFor(() => host.state.phase === "lobby");
  assert.ok(host.state.players.every((p) => p.score === 0));
});

test("an unconfigured service explains why a game cannot start and never creates a fake AI entry", async (t) => {
  const prior = Object.fromEntries(
    ["SLOP_AI_API_KEY", "OPENAI_API_KEY"].map((key) => [key, process.env[key]]),
  );
  delete process.env.SLOP_AI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  const server = createApp();
  await new Promise((resolve) => server.http.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.http.address().port}`;
  const sockets = [];
  t.after(async () => {
    sockets.forEach((socket) => socket.disconnect());
    await server.close();
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  let code;
  let hostState;
  for (let i = 0; i < 4; i++) {
    const socket = client(url, {
      transports: ["websocket"],
      reconnection: false,
    });
    sockets.push(socket);
    if (i === 0)
      socket.on("state", (state) => {
        hostState = state;
      });
    await new Promise((resolve) => socket.once("connect", resolve));
    const result = await new Promise((resolve) =>
      socket.emit(
        "join",
        {
          name: `Human ${i}`,
          token: randomBytes(32).toString("hex"),
          create: i === 0,
          code,
        },
        resolve,
      ),
    );
    assert.equal(result.ok, true);
    code ||= hostState.code;
  }
  await waitFor(() => hostState.players.length === 4);
  assert.equal(hostState.aiConfigured, false);
  const result = await new Promise((resolve) =>
    sockets[0].emit("start", {}, resolve),
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /Connect AI/);
  assert.equal(hostState.phase, "lobby");
  assert.equal(server.rooms.get(code).round, 0);
});
