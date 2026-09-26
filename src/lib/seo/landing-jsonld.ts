import { SITE_URL } from "@/lib/site";

const TRACKS: ReadonlyArray<{ code: string; label: string }> = [
  { code: "C", label: "C" },
  { code: "C++", label: "C++" },
  { code: "Java", label: "Java" },
  { code: "Python", label: "Python" },
  { code: "Web", label: "Web" },
  { code: "DSA", label: "DSA" },
  { code: "Git", label: "Git" },
  { code: "AI", label: "AI" },
];

export function landingJsonLd() {
  return {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "Organization",
        name: "Codestead",
        url: SITE_URL,
        logo: `${SITE_URL}/icon`,
      },
      {
        "@type": "EducationalOrganization",
        name: "Codestead",
        url: SITE_URL,
        description: "A private, adaptive learning studio for coding, DSA, web, and AI.",
        hasCourse: TRACKS.map((track) => ({
          "@type": "Course",
          name: `${track.label} track`,
          provider: { "@type": "Organization", name: "Codestead", sameAs: SITE_URL },
        })),
      },
    ],
  };
}
