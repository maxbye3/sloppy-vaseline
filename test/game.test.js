import test from "node:test";
import assert from "node:assert/strict";
import { Room, makeBallots } from "../server/game.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
function fixture(n = 3) {
  const room = new Room(
    "ABCDEF",
    async () => ({
      text: "AI response",
      model: "test-model",
    }),
    () => {},
  );
  for (let i = 0; i < n; i++) room.connect(`p${i}`, `Player ${i}`, "");
  return room;
}
async function writing(room) {
  room.begin(room.host);
  room.expire();
  room.setScenario(room.writer, "Write an apology for eating lunch.");
  await flush();
}

test("full-room ballots show every response once to every voter with equal eligible exposure", () => {
  for (let n = 3; n <= 24; n++) {
    const voters = Array.from({ length: n }, (_, i) => `p${i}`);
    const humans = voters.map((author) => ({
      id: author,
      author,
      text: "human",
    }));
    const responses = [...humans, { id: "ai", author: null }];
    const { ballots, exposure } = makeBallots(voters, responses);
    assert.ok(Object.values(exposure).every((count) => count === n - 1));
    for (const ballot of Object.values(ballots)) {
      assert.equal(ballot.length, n + 1);
      assert.equal(new Set(ballot).size, ballot.length);
      assert.deepEqual(new Set(ballot), new Set(responses.map((r) => r.id)));
    }
  }
});

test("complete game enforces authority, preserves anonymity, scores once, and resets", async (t) => {
  const room = fixture();
  t.after(() => room.destroy());
  assert.throws(() => room.begin("p1"), /host/);
  await writing(room);
  for (const id of room.participants) {
    room.submit(id, `Human response ${id}`);
    if (room.phase === "writing")
      assert.throws(() => room.submit(id, "again"), /locked/);
  }
  assert.equal(room.phase, "voting");
  assert.equal(room.state("p0").closing, false);
  const votingTimeLeft = room.state("p0").deadline - Date.now();
  assert.ok(votingTimeLeft > 59000 && votingTimeLeft <= 60000);
  for (const id of room.participants) {
    const s = room.state(id);
    assert.equal(s.ballot.length, 4);
    assert.ok(!("responses" in s));
    assert.ok(!("fallback" in s));
    assert.ok(s.ballot.every((r) => !("author" in r)));
  }
  const ai = room.responses.find((r) => r.author === null);
  const target = room.responses.find((r) => r.author !== null);
  let deceived = 0;
  for (const id of room.participants) {
    const vote = target.author !== id ? target.id : ai.id;
    if (vote === target.id) deceived++;
    room.vote(id, vote);
    assert.equal(
      room.phase,
      id === room.participants.at(-1) ? "reveal" : "voting",
    );
    assert.throws(() => room.vote(id, vote));
  }
  assert.equal(room.phase, "reveal");
  const result = room.results.find((r) => r.id === target.author);
  assert.equal(
    result.deception,
    Math.round((15 * deceived) / room.exposure[target.id]),
  );
  assert.ok(room.state("p0").responses.every((r) => "author" in r));
  const scores = [...room.players.values()].map((p) => p.score);
  room.reveal();
  assert.deepEqual(
    [...room.players.values()].map((p) => p.score),
    scores,
  );
  room.advance(room.host);
  room.end(room.host);
  assert.equal(room.state(room.host).awards.length, 3);
  room.again(room.host);
  assert.equal(room.phase, "lobby");
  assert.equal(room.players.size, 3);
  assert.ok(
    [...room.players.values()].every((p) => p.score === 0 && p.fooled === 0),
  );
});

test("deadline submits drafts, excludes blank responses, permits small ballots, no automatic vote", async (t) => {
  const room = fixture(4);
  t.after(() => room.destroy());
  await writing(room);
  const a = room.writer;
  const [b, c] = room.participants.filter((id) => id !== room.writer);
  room.draft(a, "An unsubmitted but valid draft");
  room.draft(b, "   ");
  room.submit(c, "A locked response");
  room.expire();
  assert.equal(room.phase, "voting");
  assert.equal(room.responses.length, 3);
  assert.equal(room.state(a).ballot.length, 3);
  assert.equal(room.state(b).ballot.length, 3);
  assert.throws(
    () => room.vote(a, room.responses.find((r) => r.author === a).id),
    /own/,
  );
  room.expire();
  assert.equal(room.phase, "reveal");
  assert.ok(room.results.every((r) => r.points === 0));
});

test("writer rotation covers everyone before repeating", (t) => {
  const room = fixture(5);
  t.after(() => room.destroy());
  const writers = new Set();
  for (let i = 0; i < 5; i++) {
    room.phase = "leaderboard";
    room.begin(room.host);
    writers.add(room.writer);
  }
  assert.equal(writers.size, 5);
});

test("rejects overlong and empty text and games with too few players", async (t) => {
  const room = fixture(2);
  t.after(() => room.destroy());
  assert.throws(() => room.begin(room.host), /three/);
  room.connect("p2", "Third", "");
  room.begin(room.host);
  room.expire();
  assert.throws(() => room.setScenario(room.writer, "x".repeat(181)), /180/);
  assert.throws(() => room.setScenario(room.writer, " "), /180/);
  assert.throws(
    () =>
      room.setScenario(
        room.participants.find((p) => p !== room.writer),
        "scenario",
      ),
    /writer/,
  );
});

test("host transfers after disconnect grace and returning players keep their scores", async (t) => {
  const room = new Room(
    "ABCDEF",
    async () => ({ text: "AI", fallback: true }),
    () => {},
    { hostGrace: 5 },
  );
  t.after(() => room.destroy());
  room.connect("host", "Host", "");
  room.connect("guest", "Guest", "");
  room.players.get("host").score = 25;
  room.disconnect("host");
  assert.equal(room.host, "host");
  await new Promise((r) => setTimeout(r, 15));
  assert.equal(room.host, "guest");
  room.connect("host", "Host", "");
  assert.equal(room.players.get("host").score, 25);
  assert.equal(room.players.size, 2);
  assert.equal(room.host, "guest");
});

for (const failBeforeSubmissions of [true, false]) {
  test(`failed AI generation ${failBeforeSubmissions ? "before" : "after"} submissions preserves answers and recovers on host retry`, async (t) => {
    const room = fixture();
    t.after(() => room.destroy());
    const requests = [];
    room.generate = (scenario) =>
      new Promise((resolve, reject) =>
        requests.push({ scenario, resolve, reject }),
      );
    await writing(room);
    const writer = room.writer;
    if (failBeforeSubmissions) {
      requests[0].reject(new Error("Provider unavailable"));
      await flush();
    }
    for (const id of room.participants) room.submit(id, `Human ${id}`);
    if (!failBeforeSubmissions) {
      requests[0].reject(new Error("Provider unavailable"));
      await flush();
    }
    assert.equal(room.phase, "ai-error");
    const humans = structuredClone(room.responses);
    assert.equal(humans.length, 3);
    assert.ok(humans.every((r) => r.author !== null));
    assert.ok([...room.players.values()].every((p) => p.score === 0));
    assert.equal(room.state(room.host).ballot.length, 0);
    assert.ok(!("responses" in room.state(room.host)));
    const guest = room.participants.find((id) => id !== room.host);
    assert.throws(() => room.retryAi(guest), /host/);
    room.retryAi(room.host);
    assert.equal(room.state(room.host).aiPending, true);
    assert.throws(() => room.retryAi(room.host), /cannot/);
    await flush();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].scenario, requests[0].scenario);
    requests[1].resolve({
      text: "I'm sorry I ate your lunch. The next one is on me.",
      model: "test-model",
      responseId: "test-response",
    });
    await flush();
    assert.equal(room.phase, "voting");
    assert.equal(room.writer, writer);
    assert.deepEqual(
      room.responses.filter((r) => r.author !== null),
      humans,
    );
    assert.equal(room.responses.filter((r) => r.author === null).length, 1);
    assert.ok(
      room
        .state(room.host)
        .ballot.every((r) => !("model" in r) && !("author" in r)),
    );
    assert.ok(!JSON.stringify(room.state(room.host)).includes("test-model"));
    const ai = room.responses.find((r) => r.author === null);
    for (const id of room.participants) room.vote(id, ai.id);
    assert.equal(room.phase, "reveal");
    assert.equal(
      room.state(room.host).responses.find((r) => r.author === null).model,
      "test-model",
    );
    assert.ok([...room.players.values()].every((p) => p.score === 10));
  });
}

for (const ai of [
  { text: "A canned substitute", fallback: true },
  { text: " " },
  { text: "x".repeat(181) },
]) {
  test("invalid or fallback entries never reach voting", async (t) => {
    const room = fixture();
    t.after(() => room.destroy());
    room.generate = async () => ai;
    await writing(room);
    room.closeWriting();
    assert.equal(room.phase, "ai-error");
    assert.equal(room.responses.length, 0);
    assert.ok([...room.players.values()].every((p) => p.score === 0));
  });
}

test("the scenario writer submits, gets an anonymous ballot, and earns both detection and deception points", async (t) => {
  const room = fixture(3);
  t.after(() => room.destroy());
  room.generate = async () => ({
    text: "The real AI response is private until voting.",
    model: "private-model",
    responseId: "private-response-id",
  });
  await writing(room);
  const writer = room.writer;
  assert.equal(room.state(writer).expected, 3);
  const writingState = JSON.stringify(room.state(writer));
  assert.ok(!writingState.includes("The real AI response"));
  assert.ok(!writingState.includes("private-model"));
  assert.ok(!writingState.includes("private-response-id"));
  room.draft(writer, "The scenario writer's own response.");
  assert.equal(room.state(writer).draft, "The scenario writer's own response.");
  for (const id of room.participants.filter((id) => id !== writer))
    room.submit(id, `Another human response from ${id}`);
  assert.equal(room.phase, "writing");
  assert.equal(room.state(writer).submitted, 2);
  room.submit(writer, room.state(writer).draft);
  assert.equal(room.phase, "voting");
  assert.equal(room.state(writer).hasSubmitted, true);
  const ownResponse = room.responses.find((r) => r.author === writer);
  const ai = room.responses.find((r) => r.author === null);
  for (const id of room.participants) {
    const state = room.state(id);
    assert.equal(state.ballot.length, 4);
    assert.ok(state.ballot.some((r) => r.id === ai.id));
    assert.ok(
      state.ballot.every(
        (r) => !("author" in r) && !("model" in r) && !("responseId" in r),
      ),
    );
    const own = room.responses.find((r) => r.author === id);
    assert.ok(state.ballot.some((r) => r.id === own.id && r.isOwn));
    assert.ok(!("responses" in state));
  }
  assert.throws(() => room.vote(writer, ownResponse.id), /own/);
  for (const id of room.participants)
    room.vote(id, id === writer ? ai.id : ownResponse.id);
  assert.equal(room.phase, "reveal");
  assert.equal(room.players.get(writer).score, 25);
  const result = room.state(writer).results.find((r) => r.id === writer);
  assert.equal(result.correct, 1);
  assert.equal(result.fooled, 2);
  assert.equal(result.deception, 15);
  assert.equal(
    room.state(writer).responses.find((r) => r.author === null).model,
    "private-model",
  );
});

for (const n of [3, 4, 5, 6, 7, 8, 9, 24]) {
  test(`${n} players see all submissions and exactly one AI, with one vote and one reveal`, async (t) => {
    const room = fixture(n);
    t.after(() => room.destroy());
    const requests = [];
    room.generate = async (...args) => {
      requests.push(args);
      return {
        text: "The sole AI entry",
        model: "private-model",
        responseId: "private-provider-id",
      };
    };
    await writing(room);
    for (const id of room.participants)
      room.submit(id, `Private human entry ${id}`);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], [room.scenario]);
    assert.equal(room.phase, "voting");
    assert.ok(room.state(room.host).deadline - Date.now() > 59000);
    const ai = room.responses.find((r) => r.author === null);
    for (const id of room.participants) {
      const state = room.state(id);
      assert.equal(state.ballot.length, n + 1);
      assert.equal(new Set(state.ballot.map((r) => r.id)).size, n + 1);
      assert.ok(!("responses" in state) && !("results" in state));
      assert.ok(!JSON.stringify(state).includes("private-model"));
      assert.ok(
        state.ballot.every(
          (r) => !("author" in r) && !("model" in r) && !("responseId" in r),
        ),
      );
      const own = state.ballot.find((r) => r.isOwn);
      assert.ok(own);
      assert.throws(() => room.vote(id, own.id), /own/);
      assert.equal(room.state(id).hasVoted, false);
      room.vote(id, ai.id);
      if (id !== room.participants.at(-1)) {
        assert.equal(room.phase, "voting");
        assert.throws(() => room.vote(id, ai.id), /locked/);
        assert.ok([...room.players.values()].every((p) => p.score === 0));
      }
    }
    assert.equal(room.phase, "reveal");
    assert.equal(requests.length, 1);
    for (const id of room.participants) {
      assert.equal(room.players.get(id).score, 10);
      assert.equal(room.state(id).ballot.length, n + 1);
      assert.equal(room.state(id).ballot.filter((r) => r.voted).length, 1);
      assert.equal(room.results.find((r) => r.id === id).shown, n - 1);
    }
    const scores = [...room.players.values()].map((p) => p.score);
    room.reveal();
    assert.deepEqual(
      [...room.players.values()].map((p) => p.score),
      scores,
    );
    room.advance(room.host);
    room.begin(room.host);
    await flush();
    assert.ok(room.state(room.host).ballot.length === 0);
    assert.equal(room.state(room.host).hasVoted, false);
  });
}

test("the actual 60-second timer reveals once without inventing uncast votes", async (t) => {
  t.mock.timers.enable({ apis: ["Date", "setTimeout"] });
  const room = fixture(7);
  t.after(() => room.destroy());
  await writing(room);
  for (const id of room.participants) room.submit(id, `Human ${id}`);
  const ai = room.responses.find((r) => r.author === null);
  room.vote(room.host, ai.id);
  t.mock.timers.tick(59999);
  assert.equal(room.phase, "voting");
  t.mock.timers.tick(1);
  assert.equal(room.phase, "reveal");
  assert.equal(room.players.get(room.host).score, 10);
  assert.ok(
    [...room.players.values()]
      .filter((p) => p.id !== room.host)
      .every((p) => p.score === 0),
  );
  assert.equal(room.responses.filter((r) => r.author === null).length, 1);
});
