import test from "node:test";
import assert from "node:assert/strict";
import {
  generateResponse,
  isAiConfigured,
  AiGenerationError,
} from "../server/ai.js";

function configure(t, key = "test-key") {
  const prior = Object.fromEntries(
    ["SLOP_AI_API_KEY", "OPENAI_API_KEY", "OPENAI_MODEL"].map((name) => [
      name,
      process.env[name],
    ]),
  );
  delete process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_MODEL;
  if (key) process.env.SLOP_AI_API_KEY = key;
  else delete process.env.SLOP_AI_API_KEY;
  t.after(() => {
    for (const [name, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  });
}
function completion(text, finish = "stop") {
  return Response.json({
    id: "chatcmpl-test",
    object: "chat.completion",
    created: 1700000000,
    model: "gpt-4o-mini-2024-07-18",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: finish,
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 30, total_tokens: 130 },
  });
}

test("missing credentials fail explicitly without a fabricated response or request", async (t) => {
  configure(t, "");
  const request = t.mock.method(globalThis, "fetch", () => {
    throw new Error("Unexpected request");
  });
  assert.equal(isAiConfigured(), false);
  await assert.rejects(
    generateResponse("A love letter"),
    (error) =>
      error instanceof AiGenerationError && error.code === "not_configured",
  );
  assert.equal(request.mock.calls.length, 0);
});

test("a scenario produces real provider text and provenance, not a canned template", async (t) => {
  configure(t);
  process.env.OPENAI_MODEL = "gpt-4o-mini";
  const scenario = "A heartfelt apology for eating someone else's lunch";
  const text =
    "I'm sorry I ate your lunch. I'll replace it today and check the name on the container next time.";
  const request = t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(String(url), "https://api.openai.com/v1/chat/completions");
    assert.equal(
      new Headers(options.headers).get("authorization"),
      "Bearer test-key",
    );
    const body = JSON.parse(options.body);
    assert.equal(body.model, "gpt-4o-mini");
    assert.deepEqual(
      body.messages.filter((m) => m.role === "user"),
      [{ role: "user", content: scenario }],
    );
    assert.ok(options.signal);
    return completion(text);
  });
  const result = await generateResponse(scenario);
  assert.deepEqual(result, {
    text,
    model: "gpt-4o-mini-2024-07-18",
    responseId: "chatcmpl-test",
  });
  assert.equal(request.mock.calls.length, 1);
});

for (const [name, text, finish] of [
  ["overlong", "A".repeat(181), "stop"],
  ["unfinished", "The thing I wanted to say was", "length"],
  ["empty", "", "stop"],
]) {
  test(`${name} output is rewritten by the model instead of being truncated`, async (t) => {
    configure(t);
    let calls = 0;
    t.mock.method(globalThis, "fetch", async (_url, options) => {
      if (++calls === 1) return completion(text, finish);
      const messages = JSON.parse(options.body).messages;
      assert.match(messages.at(-1).content, /Rewrite/);
      return completion("I'm sorry about lunch. Tomorrow's on me.");
    });
    assert.equal(
      (await generateResponse("A lunch apology")).text,
      "I'm sorry about lunch. Tomorrow's on me.",
    );
    assert.equal(calls, 2);
  });
}

test("repeated invalid output fails rather than entering a ballot", async (t) => {
  configure(t);
  t.mock.method(globalThis, "fetch", async () => completion("x".repeat(181)));
  await assert.rejects(
    generateResponse("A love letter"),
    (e) => e.code === "invalid_response",
  );
});

test("invalid credentials fail with a safe diagnostic and no fallback", async (t) => {
  configure(t);
  const warning = t.mock.method(console, "warn", () => {});
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      {
        error: {
          message: "private-provider-details",
          type: "invalid_request_error",
          code: "invalid_api_key",
        },
      },
      { status: 401 },
    ),
  );
  await assert.rejects(
    generateResponse("A private scenario"),
    (e) => e.code === "authentication",
  );
  assert.match(warning.mock.calls[0].arguments[0], /authentication, HTTP 401/);
  assert.ok(!JSON.stringify(warning.mock.calls).includes("private-"));
});

test("a transient provider failure is retried", async (t) => {
  configure(t);
  let calls = 0;
  t.mock.method(globalThis, "fetch", async () =>
    ++calls === 1
      ? Response.json({ error: { message: "Unavailable" } }, { status: 503 })
      : completion(
          "Today's lunch may be free, but the queue is an investment.",
        ),
  );
  assert.match(
    (await generateResponse("Critique Monday's free lunch")).text,
    /queue/,
  );
  assert.equal(calls, 2);
});

test("the generation deadline returns a clear failure without a substitute", async (t) => {
  configure(t);
  t.mock.method(console, "warn", () => {});
  t.mock.method(AbortSignal, "timeout", (duration) => {
    assert.equal(duration, 20000);
    return AbortSignal.abort(new DOMException("Timed out", "TimeoutError"));
  });
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    options.signal.throwIfAborted();
    throw new Error("Expected an aborted signal");
  });
  await assert.rejects(
    generateResponse("A love letter"),
    (e) => e.code === "timeout",
  );
});

test("later groups get fresh provider text and duplicated AI text is rewritten", async (t) => {
  configure(t);
  const previous = "Earlier AI entry";
  let calls = 0;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const messages = JSON.parse(options.body).messages;
    assert.ok(messages.some((m) => m.content.includes(previous)));
    return completion(
      ++calls === 1 ? previous : "A fresh joke for the same scenario.",
    );
  });
  const result = await generateResponse("Lunch etiquette", [previous]);
  assert.equal(calls, 2);
  assert.equal(result.text, "A fresh joke for the same scenario.");
});
