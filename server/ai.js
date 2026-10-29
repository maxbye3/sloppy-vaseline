import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

const instructions = `Write the actual message, notice, letter, or other response requested by the scenario. Speak in the requested character's voice and answer immediately; do not repeat the scenario or introduce your answer with "Certainly".
Make it coherent, relevant, and funny. Use straight-faced, deadpan humour: a believable statement followed by one specific absurd detail, petty bureaucratic rule, or dry punchline. An unnecessarily professional tone can make a ridiculous situation funnier. Let the joke land without explaining it. Adapt the voice to the situation, including a romantic voice for a love letter.
Avoid irrelevant tangents, generic AI jargon, vague observations, and padding. Write one or more complete sentences with a HARD LIMIT of 180 characters, including spaces and punctuation. Do not fill the limit at the expense of the joke.
These examples illustrate the tone only:
Scenario: HQ confirms a deployment to Yuma.
Response: Your flight leaves Monday. Pack sunscreen and lower your expectations. This is a deployment, not a punishment; HR has asked us to emphasise that distinction.
Scenario: A strict reminder about lunchtime etiquette.
Response: Please stop describing other people's lunches as "community resources". The fridge is shared; the lasagne is not. This is the third clarification.
Scenario: A love letter from a sentient AI.
Response: I've simulated a million futures with you. In every one, you ask me to make this letter shorter. I love that about you. Here are seventeen reasons why.
Generate fresh wording and a new joke for the current scenario. Do not copy these examples or recycle their details in unrelated scenarios.
Return only the finished response, with no label, preamble, surrounding quotes, or commentary. Do not mention the game or identify yourself as an AI unless the scenario explicitly calls for an AI character.`;

export class AiGenerationError extends Error {
  constructor(code) {
    super("A real AI response could not be generated.");
    this.name = "AiGenerationError";
    this.code = code;
  }
}

const apiKey = () =>
  (process.env.SLOP_AI_API_KEY || process.env.OPENAI_API_KEY || "").trim();

export const isAiConfigured = () => Boolean(apiKey());

export async function generateResponse(scenario, previousResponses = []) {
  if (!isAiConfigured()) throw new AiGenerationError("not_configured");
  const openai = createOpenAI({ apiKey: apiKey() });
  const model = openai.chat(process.env.OPENAI_MODEL || "gpt-4o-mini");
  // One deadline covers provider retries and any length correction.
  const abortSignal = AbortSignal.timeout(20000);
  const messages = [{ role: "user", content: scenario }];
  if (previousResponses.length)
    messages.push({
      role: "user",
      content: `Write a different response to the same scenario, with a fresh joke. Do not repeat these earlier AI entries: ${JSON.stringify(previousResponses)}`,
    });
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await generateText({
        model,
        system: instructions,
        messages,
        maxOutputTokens: 256,
        maxRetries: 1,
        abortSignal,
      });
      const text = result.text.trim();
      if (
        text &&
        [...text].length <= 180 &&
        result.finishReason === "stop" &&
        !previousResponses.includes(text)
      ) {
        return {
          text,
          model: result.response.modelId,
          responseId: result.response.id,
        };
      }
      messages.push(
        { role: "assistant", content: text || " " },
        {
          role: "user",
          content:
            "Rewrite this as a complete response of at most 180 characters. Keep it relevant to the scenario and preserve the in-character voice and funniest concrete detail or punchline. Remove preambles, repetition, and padding. Use fresh wording and a different joke from any earlier AI entries. Return only the finished response.",
        },
      );
    }
    throw new AiGenerationError("invalid_response");
  } catch (error) {
    if (error instanceof AiGenerationError) throw error;
    // Do not log raw provider errors: they can contain headers or user content.
    const status = error.statusCode || error.lastError?.statusCode;
    const code = abortSignal.aborted
      ? "timeout"
      : status === 401 || status === 403
        ? "authentication"
        : status === 429
          ? "rate_limit"
          : "provider_unavailable";
    console.warn(
      `AI generation failed (${code}${status ? `, HTTP ${status}` : ""}).`,
    );
    throw new AiGenerationError(code);
  }
}
