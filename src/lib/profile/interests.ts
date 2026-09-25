export const INTEREST_CATEGORIES = [
  "cooking",
  "cars",
  "games",
  "sports",
  "music",
  "art",
  "travel",
  "technology",
  "animals",
  "nature",
  "science",
  "everyday-life",
] as const;

export type InterestCategory = typeof INTEREST_CATEGORIES[number];

// "everyday-life" is the catch-all bucket for anything that does not match a
// recognized pattern below; the UI shows it to learners as "Other" so an
// unrecognized entry still reads as intentionally kept, not silently dropped.
export const OTHER_INTEREST_CATEGORY: InterestCategory = "everyday-life";

const categoryPatterns: Array<[InterestCategory, RegExp]> = [
  ["cooking", /cook|food|bak|kitchen|recipe/i],
  ["cars", /car|auto|motor|bike|racing|vehicle/i],
  ["games", /game|chess|esport|playstation|xbox/i],
  ["sports", /sport|cricket|football|soccer|basket|tennis|gym/i],
  ["music", /music|song|guitar|piano|sing|drum/i],
  ["art", /art|draw|paint|design|photo/i],
  ["travel", /travel|trip|hike|trek|explor/i],
  ["technology", /code|computer|robot|tech|gadget/i],
  ["animals", /animal|pet\b|pets|cat|dog|kitten|puppy|bird|fish|reptile|horse/i],
  ["nature", /nature|garden|plant|wildlife|outdoor|hiking|forest/i],
  ["science", /science|physics|chemistry|biology|astronom|experiment|space\b/i],
];

/** Every category with a few example words shown in the UI as hints. */
export const INTEREST_CATEGORY_EXAMPLES: Record<InterestCategory, readonly string[]> = {
  cooking: ["baking", "recipes", "grilling"],
  cars: ["racing", "motorbikes", "car shows"],
  games: ["chess", "video games", "esports"],
  sports: ["cricket", "football", "the gym"],
  music: ["guitar", "singing", "concerts"],
  art: ["drawing", "photography", "painting"],
  travel: ["hiking", "road trips", "exploring cities"],
  technology: ["coding", "robots", "gadgets"],
  animals: ["cats", "dogs", "birdwatching"],
  nature: ["gardening", "the outdoors", "wildlife"],
  science: ["astronomy", "chemistry", "physics"],
  "everyday-life": ["reading", "movies", "board games"],
};

export function inferInterestCategory(label: string): InterestCategory {
  return categoryPatterns.find(([, pattern]) => pattern.test(label))?.[0] ?? OTHER_INTEREST_CATEGORY;
}

/** True only when the label matched a specific category, not the catch-all bucket. */
export function isRecognizedInterest(label: string): boolean {
  return categoryPatterns.some(([, pattern]) => pattern.test(label));
}

const JUNK_INTEREST_TERMS = new Set([
  "n/a", "na", "none", "nothing", "idk", "dunno", "test", "testing", "asdf", "qwerty", "xxx",
]);

/**
 * Rejects entries that carry no real signal (filler, placeholders, or
 * symbol/number-only noise) so they never reach the learner's interest list.
 * Anything that fails this check must be reported back with a reason, never
 * dropped without explanation.
 */
export function junkInterestReason(label: string): string | null {
  const trimmed = label.trim();
  if (!trimmed) return "It was empty.";
  const normalized = trimmed.toLowerCase();
  if (JUNK_INTEREST_TERMS.has(normalized)) return "It doesn't describe an interest.";
  if (!/[a-zA-Z]/.test(trimmed)) return "It needs at least one letter.";
  if (/<[^>]*>/.test(trimmed)) return "It can't contain markup.";
  if (/^(.)\1{3,}$/u.test(normalized.replaceAll(/\s+/gu, ""))) return "It looks like a repeated character, not an interest.";
  return null;
}
