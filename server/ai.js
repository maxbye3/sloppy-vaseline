import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

const instructions = `Write a deliberately stereotypical AI response loosely inspired by the scenario.
Be as irrelevant, unconcise, and verbose as possible within a HARD LIMIT of 180 characters, including spaces and punctuation. Aim for 170–180 characters.
Use excessive preambles, redundant caveats, corporate jargon, strained metaphors, unnecessary tangents, and vague reassurance. Prefer explaining the importance of responding over actually providing a useful answer. Avoid crisp answers and punchy jokes.
Keep one recognisable detail from the scenario, then wander into a pompous, barely relevant observation. Lean into needless nuance, holistic perspectives, multifaceted journeys, and conspicuously artificial politeness. Vary the wording and openings; do not repeat a fixed template.
Return one complete, self-contained response, with no label or surrounding quotes. Finish the thought within the character limit rather than cutting off mid-sentence. Do not mention the game or identify yourself as an AI unless the scenario explicitly calls for an AI character.`;

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

export async function generateResponse(scenario) {
  if (!isAiConfigured()) throw new AiGenerationError("not_configured");
  const openai = createOpenAI({ apiKey: apiKey() });
  const model = openai.chat(process.env.OPENAI_MODEL || "gpt-4o-mini");
  // One deadline covers provider retries and any length correction.
  const abortSignal = AbortSignal.timeout(20000);
  const messages = [{ role: "user", content: scenario }];
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
      if (text && [...text].length <= 180 && result.finishReason === "stop") {
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
            "Rewrite this as one complete response of at most 180 characters, aiming for 170–180. Preserve the rambling tangents, redundant caveats, and stereotypical AI jargon; do not turn it into a concise, useful answer. Return only the finished response.",
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
