import { ProviderError, type TutorMessage } from "./types";

// Only the final answer crosses the display/storage boundary. Never return a
// reasoning field, even when the provider ignored its suppression setting.
export function safeTutorResponse(text: string, messages: TutorMessage[] = []) {
  const content = text.replace(/<\s*(think|thinking)\s*>[\s\S]*?<\s*\/\s*\1\s*>/gi, "").trim();
  const reasoningDetected = content !== text.trim();
  const leadingReasoningLabel = /^(?:\*\*|#{1,6}\s*)?(?:analysis|internal reasoning|chain[ -]of[ -]thought)(?:\*\*)?[ \t]*(?::[ \t]*(?:\*\*)?\s*|\r?\n\s*)(?=\S)(?!\*\*$)/i.test(content);
  const leakedTrace = leadingReasoningLabel || /<\s*\/?\s*(?:think|thinking)\b|(?:here(?:'s| is)|this is)\s+(?:my |a |the )?(?:thinking process|reasoning process)|\bI (?:need to|must|should|have to)\b.{0,100}(?:system prompt|instructions)|\bmy system prompt\b|\bmy instructions (?:say|said|tell|told|require|are|were|state)\b|\bthe (?:user|learner) (?:asks|asked|wants|wanted|says|said|is asking)\b[^\n]{0,160}?(?:\bI(?:'ll| will| should| need to| must| have to| can)\b|\blet me\b)|You are Patch, the Codestead tutor/i.test(content);
  const normalized = content.replace(/\s+/g, " ").toLowerCase();
  const echoesSystem = messages.some((message) => message.role === "system" &&
    message.content.split(/\n+/).some((line) => {
      const instruction = line.trim().replace(/\s+/g, " ").toLowerCase();
      return instruction.length >= 60 && normalized.includes(instruction);
    }));
  if (leakedTrace || echoesSystem) {
    throw new ProviderError("This model returns reasoning text. Its response was blocked.", "REASONING_LEAK");
  }
  if (!content) throw new ProviderError("Provider returned no tutor text.", reasoningDetected ? "REASONING_LEAK" : "BAD_RESPONSE");
  return { content, reasoningDetected };
}
