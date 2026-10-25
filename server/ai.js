import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

const instructions = `Write the actual response requested by the scenario.
Match its purpose, tone, and specific details: a love letter should be a love letter, an apology should apologise, and a proposal should propose something concrete.
Write one complete, self-contained response of at most 180 characters, including spaces and punctuation. Aim for 100–160 characters.
Return only the response, without a label, surrounding quotes, or an explanation. Do not discuss the scenario, the game, or being an AI. Do not imitate stereotypical AI jargon or add generic corporate filler.`;

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
            "Rewrite this as one complete response under 180 characters. Return only the finished response.",
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
