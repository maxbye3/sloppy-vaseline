import test from "node:test";
import assert from "node:assert/strict";
import { Room, makeBallots } from "../server/game.js";
import { generateResponse } from "../server/ai.js";

const flush = () => new Promise((resolve) => setImmediate(resolve));
function fixture(n = 5) {
  const room = new Room(
    "ABCDEF",
    async () => ({ text: "AI response", fallback: false }),
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

test("ballots exclude self, contain one AI, have no duplicates, and balance exposure", () => {
  for (let n = 4; n <= 24; n++) {
    const voters = Array.from({ length: n }, (_, i) => `p${i}`);
    const responses = voters
      .slice(1)
      .map((author, i) => ({ id: `r${i}`, author, text: "human" }));
    responses.push({ id: "ai", author: null, text: "AI" });
    for (let run = 0; run < 30; run++) {
      const { ballots, exposure } = makeBallots(voters, responses);
      for (const [id, ballot] of Object.entries(ballots)) {
        assert.equal(
          ballot.length,
          Math.min(
            3,
            responses.filter((r) => r.author !== null && r.author !== id)
              .length,
          ) + 1,
        );
        assert.equal(new Set(ballot).size, ballot.length);
        assert.ok(ballot.includes("ai"));
        assert.ok(
          !ballot.some(
            (rid) => responses.find((r) => r.id === rid).author === id,
          ),
        );
      }
      const counts = Object.values(exposure);
      assert.ok(Math.max(...counts) - Math.min(...counts) <= 2);
    }
  }
});

test("complete game enforces authority, preserves anonymity, scores once, and resets", async (t) => {
  const room = fixture();
  t.after(() => room.destroy());
  assert.throws(() => room.begin("p1"), /host/);
  await writing(room);
  assert.throws(() => room.submit(room.writer, "no"), /cannot/);
  for (const id of room.participants.filter((id) => id !== room.writer)) {
    room.submit(id, `Human response ${id}`);
    if (room.phase === "writing")
      assert.throws(() => room.submit(id, "again"), /locked/);
  }
  assert.equal(room.phase, "voting");
  assert.equal(room.state("p0").closing, false);
  assert.ok(room.state("p0").deadline > Date.now());
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
    const vote = room.ballots[id].includes(target.id) ? target.id : ai.id;
    if (vote === target.id) deceived++;
    room.vote(id, vote);
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
  assert.equal(room.players.size, 5);
  assert.ok(
    [...room.players.values()].every((p) => p.score === 0 && p.fooled === 0),
  );
});

test("deadline submits drafts, excludes blank responses, permits small ballots, no automatic vote", async (t) => {
  const room = fixture(4);
  t.after(() => room.destroy());
  await writing(room);
  const [a, b, c] = room.participants.filter((id) => id !== room.writer);
  room.draft(a, "An unsubmitted but valid draft");
  room.draft(b, "   ");
  room.submit(c, "A locked response");
  room.expire();
  assert.equal(room.phase, "voting");
  assert.equal(room.responses.length, 3);
  assert.equal(room.state(a).ballot.length, 2);
  assert.equal(room.state(b).ballot.length, 3);
  assert.throws(
    () => room.vote(a, room.responses.find((r) => r.author === a).id),
    /ballot/,
  );
  room.expire();
  assert.equal(room.phase, "reveal");
  assert.ok(room.results.every((r) => r.points === 0));
});

test("writer rotation covers everyone before repeating", (t) => {
  const room = fixture();
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
  const room = fixture(3);
  t.after(() => room.destroy());
  assert.throws(() => room.begin(room.host), /four/);
  room.connect("p3", "Fourth", "");
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

test("AI fallback is bounded and responds to the scenario without human input", async () => {
  const prior = process.env.OPENAI_API_KEY;
  const slopPrior = process.env.SLOP_AI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.SLOP_AI_API_KEY;
  try {
    const result = await generateResponse("A love letter");
    assert.equal(result.fallback, true);
    assert.ok(result.text.includes("A love letter"));
    assert.ok([...result.text].length <= 180);
  } finally {
    if (prior !== undefined) process.env.OPENAI_API_KEY = prior;
    if (slopPrior !== undefined) process.env.SLOP_AI_API_KEY = slopPrior;
  }
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
