export const INTEREST_CATEGORIES = [
  "cooking",
  "cars",
  "games",
  "sports",
  "music",
  "art",
  "travel",
  "technology",
  "everyday-life",
] as const;

export type InterestCategory = typeof INTEREST_CATEGORIES[number];

const categoryPatterns: Array<[InterestCategory, RegExp]> = [
  ["cooking", /cook|food|bak|kitchen|recipe/i],
  ["cars", /car|auto|motor|bike|racing|vehicle/i],
  ["games", /game|chess|esport|playstation|xbox/i],
  ["sports", /sport|cricket|football|soccer|basket|tennis|gym/i],
  ["music", /music|song|guitar|piano|sing|drum/i],
  ["art", /art|draw|paint|design|photo/i],
  ["travel", /travel|trip|hike|trek|explor/i],
  ["technology", /code|computer|robot|tech|gadget/i],
];

export function inferInterestCategory(label: string): InterestCategory {
  return categoryPatterns.find(([, pattern]) => pattern.test(label))?.[0] ?? "everyday-life";
}
