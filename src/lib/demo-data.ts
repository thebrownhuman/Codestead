export type CourseStatus = "learning" | "review_due" | "locked" | "available";

export interface CourseCardData {
  id: string;
  shortCode: string;
  title: string;
  description: string;
  progress: number;
  mastered: number;
  total: number;
  status: CourseStatus;
  accent: "green" | "orange" | "blue" | "gold" | "violet";
  nextSkill: string;
}

export const learner = {
  name: "Aarav",
  firstName: "Aarav",
  level: 7,
  xp: 1840,
  streak: 7,
  weeklyMinutes: 146,
  reviewsDue: 4,
  mastery: 68
};

export const courses: CourseCardData[] = [
  {
    id: "python",
    shortCode: "PY",
    title: "Python Foundations",
    description: "Build a reliable mental model of values, control flow, functions, and collections.",
    progress: 64,
    mastered: 18,
    total: 31,
    status: "learning",
    accent: "green",
    nextSkill: "String transformations"
  },
  {
    id: "dsa",
    shortCode: "DS",
    title: "Data Structures",
    description: "Trace, implement, test, and compare the structures behind real programs.",
    progress: 28,
    mastered: 7,
    total: 42,
    status: "review_due",
    accent: "orange",
    nextSkill: "Linked-list deletion"
  },
  {
    id: "git-tooling",
    shortCode: "GT",
    title: "Git & Debugging",
    description: "Turn experiments into safe, explainable changes with a repeatable workflow.",
    progress: 16,
    mastered: 3,
    total: 22,
    status: "available",
    accent: "blue",
    nextSkill: "Reading a diff"
  },
  {
    id: "ai",
    shortCode: "AI",
    title: "AI, RAG & Agents",
    description: "Understand modern AI systems from embeddings through reliable agent workflows.",
    progress: 0,
    mastered: 0,
    total: 39,
    status: "locked",
    accent: "violet",
    nextSkill: "Requires Python functions"
  }
];

export const weeklyActivity = [28, 18, 36, 14, 31, 12, 7];

export const reviews = [
  { id: "py-strings", title: "String indexing", course: "Python", due: "Now", confidence: 72 },
  { id: "dsa-complexity", title: "Space complexity", course: "DSA", due: "Now", confidence: 68 },
  { id: "py-scope", title: "Function scope", course: "Python", due: "Today", confidence: 81 },
  { id: "git-commit", title: "Atomic commits", course: "Git", due: "Today", confidence: 76 }
];

export const community = [
  { rank: 1, name: "Meera", initials: "MK", xp: 2440, streak: 12, highlight: "2 new masteries" },
  { rank: 2, name: "Shivam", initials: "SS", xp: 2115, streak: 9, highlight: "Project shipped" },
  { rank: 3, name: "Aarav", initials: "AR", xp: 1840, streak: 7, highlight: "Strong comeback", current: true }
];
