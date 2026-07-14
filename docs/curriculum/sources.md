# Curriculum source policy and registry

Last reviewed: 2026-07-12

Course manifests carry their own minimal source registries so every skill can use local `source_refs`. This document records the global source-selection policy and the current Launch 1 source baseline.

## Source hierarchy

Use sources in this order:

1. Published standards and language specifications.
2. Official documentation maintained by the language, runtime, browser, library or tool project.
3. Joint professional curriculum guidance, especially ACM/IEEE-CS/AAAI CS2023.
4. Government or recognized security and accessibility standards.
5. Primary peer-reviewed research for claims that are not defined by a standard.
6. Secondary tutorials only to discover an issue; do not make them the canonical authority when a primary source exists.

Curriculum content must be original explanation and examples. Sources support facts, scope and expected behavior; they are not permission to copy substantial source text or commercial course material.

## Curriculum and professional foundations

| ID | Authority | Version | URL |
|---|---|---|---|
| `cs2023-sdf` | CS2023 Software Development Fundamentals | August 2023 | <https://csed.acm.org/wp-content/uploads/2023/09/SDF-Version-Gamma.pdf> |
| `cs2023-al` | CS2023 Algorithmic Foundations | August 2023 | <https://csed.acm.org/wp-content/uploads/2023/09/AL-Version-Gamma.pdf> |
| `cs2023-msf` | CS2023 Mathematical and Statistical Foundations | August 2023 | <https://csed.acm.org/wp-content/uploads/2023/09/MSF-Version-Gamma-V3.pdf> |
| `cs2023-se` | CS2023 Software Engineering | August 2023 | <https://csed.acm.org/wp-content/uploads/2023/09/SE-Version-Gamma.pdf> |
| `cs2023-ai` | CS2023 Artificial Intelligence | August 2023 | <https://csed.acm.org/wp-content/uploads/2023/09/AI-Version-Gamma.pdf> |
| `acm-ethics` | ACM Code of Ethics and Professional Conduct | 2018 | <https://www.acm.org/code-of-ethics> |
| `ies-learning` | U.S. IES study-practice guide | 2007 | <https://ies.ed.gov/ncee/wwc/PracticeGuide/1> |

CS2023 defines the breadth baseline, core/elective distinction and observable learning-outcome model. It does not replace current language specifications or project documentation.

## C and C++

| ID | Authority | Version | URL |
|---|---|---|---|
| `wg14-c23` | ISO C Working Group | ISO/IEC 9899:2024, C23 | <https://www9.open-std.org/JTC1/SC22/WG14/> |
| `gnu-c` | GNU Project | Living GNU C introductory/reference manual | <https://www.gnu.org/software/c-intro-and-ref/manual/html_node/index.html> |
| `cert-c` | Carnegie Mellon SEI | Living CERT C coding standard | <https://wiki.sei.cmu.edu/confluence/display/c/SEI+CERT+C+Coding+Standard> |
| `isocpp-status` | Standard C++ Foundation | C++23 published; C++26 in progress | <https://isocpp.org/std/status> |
| `cpp-core` | Standard C++ Foundation | Living C++ Core Guidelines | <https://isocpp.org/guidelines> |
| `isocpp-tour` | Standard C++ Foundation | Current tour | <https://isocpp.org/tour> |

C content targets the portable C23 core supported by the pinned runner. C++ content targets C++20 with labeled C++23 additions until runner conformance permits changing the baseline. Implementation extensions must be labeled and cannot silently become required portable behavior.

## Java and Python

| ID | Authority | Version | URL |
|---|---|---|---|
| `dev-java` | Oracle Java team | Current official learning catalog | <https://dev.java/learn/> |
| `jls21` | Oracle | Java Language Specification, SE 21 | <https://docs.oracle.com/javase/specs/jls/se21/html/> |
| `junit5` | JUnit project | Current JUnit 5 user guide | <https://junit.org/junit5/docs/current/user-guide/> |
| `maven` | Apache Maven project | Current getting-started guide | <https://maven.apache.org/guides/getting-started/> |
| `py-tutorial` | Python Software Foundation | Python 3.14 tutorial | <https://docs.python.org/3.14/tutorial/index.html> |
| `py-reference` | Python Software Foundation | Python 3.14 language reference | <https://docs.python.org/3.14/reference/index.html> |
| `py-stdlib` | Python Software Foundation | Python 3.14 standard library | <https://docs.python.org/3.14/library/index.html> |
| `py-packaging` | Python Packaging Authority | Current packaging guide | <https://packaging.python.org/en/latest/> |

The Java baseline is JDK 21 LTS with preview features disabled, matching the pinned OpenJDK 21 runner and `javac --release 21` verification. The Python baseline is CPython 3.14. Frameworks such as Spring and libraries such as NumPy/Pandas require separate manifests and dependency versions.

## Web platform

| ID | Authority | Version | URL |
|---|---|---|---|
| `whatwg-html` | WHATWG | HTML Living Standard | <https://html.spec.whatwg.org/> |
| `css-snapshot` | W3C CSS Working Group | CSS Snapshot 2024 | <https://www.w3.org/TR/css-2024/> |
| `css-cascade` | W3C CSS Working Group | Cascading and Inheritance Level 5 | <https://www.w3.org/TR/css-cascade-5/> |
| `ecma262` | Ecma TC39 | Living ECMAScript specification | <https://tc39.es/ecma262/> |
| `whatwg-dom` | WHATWG | DOM Living Standard | <https://dom.spec.whatwg.org/> |
| `whatwg-fetch` | WHATWG | Fetch Living Standard | <https://fetch.spec.whatwg.org/> |
| `wcag22` | W3C | WCAG 2.2 Recommendation | <https://www.w3.org/TR/WCAG22/> |
| `wai-aria` | W3C WAI | Current ARIA Authoring Practices Guide | <https://www.w3.org/WAI/ARIA/apg/> |
| `mdn-html` | Mozilla contributors | Current HTML reference and guide | <https://developer.mozilla.org/en-US/docs/Web/HTML> |
| `mdn-css` | Mozilla contributors | Current CSS reference and guide | <https://developer.mozilla.org/en-US/docs/Web/CSS> |
| `mdn-js` | Mozilla contributors | Current JavaScript guide | <https://developer.mozilla.org/en-US/docs/Web/JavaScript/Guide> |
| `owasp-xss` | OWASP | Current XSS prevention guidance | <https://cheatsheetseries.owasp.org/cheatsheets/Cross_Site_Scripting_Prevention_Cheat_Sheet.html> |

WHATWG, W3C and Ecma sources define behavior. MDN supplies implementation-oriented explanation and compatibility context but does not override a standard. The published course must declare and test an explicit browser support matrix.

## React

| ID | Authority | Version | URL |
|---|---|---|---|
| `react-docs` | React project | React 19.2 Learn and Reference | <https://react.dev/> |
| `react-versions` | React project | Latest 19.2; 19.2.7 released June 2026 | <https://react.dev/versions> |
| `react-router` | React Router project | 8.0.1 declarative-mode documentation; exact runtime package pinned | <https://reactrouter.com/start/declarative/installation> |
| `react-testing` | Testing Library project | Current React Testing Library | <https://testing-library.com/docs/react-testing-library/intro/> |

Each published React course version must pin exact dependency patches in its application lockfile. A new patch can receive a course patch release after security and behavior checks. A new React major requires a course major review and migration map. React Server Components are outside Launch 1 and cannot be inferred from the client course.

## Git, collaboration and secure development

| ID | Authority | Version | URL |
|---|---|---|---|
| `git-docs` | Git project | Current stable command reference | <https://git-scm.com/docs> |
| `pro-git` | Git project | Pro Git, second edition | <https://git-scm.com/book/en/v2> |
| `github-docs` | GitHub | Current platform documentation | <https://docs.github.com/en> |
| `nist-ssdf` | NIST | SP 800-218 v1.1 | <https://csrc.nist.gov/pubs/sp/800/218/final> |

Git concepts must be tool-host neutral. GitHub-specific issues, pull requests and CI examples are labeled platform behavior, not Git language behavior.

## Artificial intelligence

| ID | Authority | Version | URL |
|---|---|---|---|
| `nist-ai-rmf` | NIST | AI RMF 1.0; revision monitored | <https://www.nist.gov/itl/ai-risk-management-framework> |
| `nist-genai` | NIST | NIST AI 600-1, July 2024 | <https://nvlpubs.nist.gov/nistpubs/ai/NIST.AI.600-1.pdf> |
| `sklearn` | scikit-learn project | 1.9.x target | <https://scikit-learn.org/stable/user_guide.html> |
| `transformers` | Hugging Face | Transformers 5.x target | <https://huggingface.co/docs/transformers/index> |
| `rag-paper` | Lewis et al. | 2020 primary RAG paper | <https://arxiv.org/abs/2005.11401> |

The AI course treats fast-moving model and vendor material as versioned evidence, not timeless fact. NIST announced that AI RMF 1.0 is under revision; the source must be rechecked before verified publication. Live model output cannot become canonical curriculum without admin review, deterministic fixtures and source support.

## Version baselines

| Track | Curriculum baseline | Update trigger |
|---|---|---|
| C | C23 portable subset | WG14 revision, material defect resolution, runner conformance change |
| C++ | C++20 plus labeled C++23 | New baseline decision or compiler/library conformance change |
| Java | Java SE 21 LTS | New chosen LTS or material JDK/security change |
| Python | Python 3.14 | New chosen feature series or incompatible packaging/runtime change |
| HTML/DOM/Fetch | Living standards at course review date | Material standard or target-browser behavior change |
| CSS | CSS Snapshot 2024 modules | New snapshot and verified target-browser support |
| JavaScript | Current standardized ECMAScript supported by target matrix | Annual ECMAScript edition or browser-matrix change |
| React | React 19.2 exact patch pinned by release | Security patch, behavior patch or major release |
| Git | Current stable Git used by runner | Command behavior, default or security change |
| AI tools | Python 3.14, scikit-learn 1.9.x, Transformers 5.x | Library, model fixture, NIST guidance or security change |

## Review and publication rules

- Check living standards and fast-moving project documentation at least quarterly and before any verified release.
- Check pinned runtimes and dependencies on each security update and proposed course release.
- Record access/review date in a source entry when the source has no immutable edition.
- Never silently rewrite a published manifest. Patch, minor or major changes create a new immutable course version.
- A changed required outcome, prerequisite, mastery rule, runtime major or source baseline requires a major curriculum version.
- Keep learners pinned to their enrolled major until an explicit migration maps old and new skill IDs.
- If an official source conflicts with existing course material, mark the affected skill blocked from verification until the discrepancy is resolved.
- If a source disappears, preserve its bibliographic metadata, replace it with an equal or stronger authority, and review every referring skill.

## AI-generated explanation policy

AI may vary analogy, reading level, examples and hint granularity only around the published skill graph. It may not change definitions, outcomes, prerequisites, expected answers, rubrics or supported runtime behavior. Generated explanations must cite or retrieve from the approved source set, state uncertainty when evidence is absent and remain disposable until an admin promotes a reviewed version into canonical content.

## Source audit checks

Before publication, automated checks should verify that:

- every `source_refs` value exists in the same manifest;
- repeated source IDs map to identical titles and URLs across manifests;
- every URL is syntactically valid and receives a periodic availability check;
- no required skill lacks a primary or official source;
- standards marked living have a current review date; and
- copyright-sensitive source text has not been copied into lessons or examples.

The 2026-07-12 consistency audit found 46 unique source IDs and no conflicting repeated ID/title/URL mappings.
