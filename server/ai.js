export async function generateResponse(scenario) {
  const apiKey = process.env.SLOP_AI_API_KEY || process.env.OPENAI_API_KEY;
  if (apiKey) {
    try {
      const response = await fetch(
        "https://api.openai.com/v1/chat/completions",
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(8000),
          body: JSON.stringify({
            model: process.env.OPENAI_MODEL || "gpt-4o-mini",
            messages: [
              {
                role: "system",
                content:
                  "You are the AI contestant in a party game. Respond directly to the scenario in at most 180 characters. Sound plausibly AI-written, but vary your style. Return only the response, with no surrounding quotes.",
              },
              { role: "user", content: scenario },
            ],
            max_tokens: 100,
          }),
        },
      );
      if (!response.ok) throw new Error("AI service unavailable");
      const body = await response.json();
      const text = body.choices?.[0]?.message?.content?.trim();
      if (text)
        return { text: [...text].slice(0, 180).join(""), fallback: false };
    } catch {
      console.warn(
        "AI generation unavailable; using a fallback for this round.",
      );
    }
  }
  const topic = [...scenario].slice(0, 65).join("");
  return {
    text: `Regarding “${topic}”: let's acknowledge the challenges, align on next steps, and turn this into an opportunity for meaningful growth.`,
    fallback: true,
  };
}
