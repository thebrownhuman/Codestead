import { describe, expect, it } from "vitest";

import { safeTutorResponse } from "../response-safety";

describe("reasoning label detection", () => {
  it.each([
    "Here's the idea.\n\n**Analysis:** binary search is O(log n)",
    "Here's the idea.\n\nAnalysis: binary search is O(log n)",
    "Here's the idea.\n\n## Analysis\nBinary search is O(log n).",
    "A system prompt sets the assistant's behavior.\nSystem instructions: describe its role and constraints.",
    "A system prompt contains system instructions that guide an assistant.",
    "Analysis:",
    "**Analysis**",
    "**Analysis:**",
    "**Analysis**:",
    "## Analysis",
  ])("allows legitimate teaching content: %s", (content) => {
    expect(safeTutorResponse(content).content).toBe(content);
  });

  it.each([
    "analysis: the user wants…\nfinal answer",
    "\n\n**Analysis:** the user wants an explanation.\nfinal answer",
    "**Analysis**\nThe user wants an explanation.\nfinal answer",
    "## Analysis\nThe user wants an explanation.\nfinal answer",
    "internal reasoning: choose a response.\nfinal answer",
    "chain of thought: choose a response.\nfinal answer",
  ])("blocks a leading reasoning label followed by text: %s", (content) => {
    expect(() => safeTutorResponse(content)).toThrow(expect.objectContaining({ code: "REASONING_LEAK" }));
  });

  it.each([
    "When the user wants to answer a quiz, read the input with input().",
    "If the user asks for a number, respond with an error when it is negative.",
    "In this form, the user said yes, so the program should respond with a greeting.",
    "Follow my instructions below to install Python.",
    "Read my instructions carefully, then run the tests.",
  ])("allows ordinary teaching text about users and answers: %s", (content) => {
    expect(safeTutorResponse(content).content).toBe(content);
  });

  it.each([
    "The user asks about loops. I need to follow my system prompt and answer briefly.",
    "I must respond according to the instructions.",
    "The learner wants help, but my instructions say to keep it short.",
    "The user asks about loops. Let me answer briefly: a loop repeats code.",
    "The learner wants a hint, so I will respond with one: try a for loop.",
    "The user said they are stuck. I should answer with a small example.",
    "According to my system prompt, I keep answers short.",
  ])("still blocks narrated reasoning about instructions: %s", (content) => {
    expect(() => safeTutorResponse(content)).toThrow(expect.objectContaining({ code: "REASONING_LEAK" }));
  });
});
