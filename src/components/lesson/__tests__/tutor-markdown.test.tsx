import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TutorMarkdown } from "../tutor-markdown";

describe("TutorMarkdown", () => {
  it("renders headings and never raw HTML, and demotes h1/h2 while opening links safely", () => {
    render(<TutorMarkdown>{`# Heading one\n## Heading two\n### Heading three\n\n<script>alert(1)</script>\n\n[a link](https://example.test)`}</TutorMarkdown>);

    expect(screen.getAllByRole("heading", { level: 3 })).toHaveLength(2);
    expect(screen.getByRole("heading", { level: 4 })).toHaveTextContent("Heading three");
    expect(document.querySelector("script")).toBeNull();
    expect(screen.getByText("<script>alert(1)</script>")).toBeInTheDocument();
    const link = screen.getByRole("link", { name: "a link" });
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noreferrer noopener");
    expect(link).toHaveAttribute("href", "https://example.test");
  });

  it("highlights a python code block with comments, strings, numbers, keywords, and calls", () => {
    const code = "```python\n# a comment\ndef add(x, y):\n    return x + 1 if print(x) else \"text\"\n```";
    render(<TutorMarkdown>{code}</TutorMarkdown>);

    const pre = document.querySelector("pre");
    expect(pre).not.toBeNull();
    expect(pre?.textContent).toContain("# a comment");
    expect(pre?.textContent).toContain('"text"');
  });

  it("highlights a hash-less language using // and /* */ comment styles", () => {
    const code = "```javascript\n// line comment\n/* block */\nfunction run() { return 42; }\n```";
    render(<TutorMarkdown>{code}</TutorMarkdown>);

    const pre = document.querySelector("pre");
    expect(pre?.textContent).toContain("// line comment");
    expect(pre?.textContent).toContain("/* block */");
    expect(pre?.textContent).toContain("42");
  });

  it("renders a plain code block with no language label as 'code'", () => {
    render(<TutorMarkdown>{"```\nplain text block\n```"}</TutorMarkdown>);

    expect(screen.getByText("code")).toBeInTheDocument();
  });

  it("copies code to the clipboard and reflects the copied state", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText }, configurable: true, writable: true,
    });
    render(<TutorMarkdown>{"```\nconst x = 1;\n```"}</TutorMarkdown>);

    await user.click(screen.getByRole("button", { name: "Copy code" }));
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledWith("const x = 1;");
  });

  it("stays uncopied when the clipboard write is rejected", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.defineProperty(window.navigator, "clipboard", {
      value: { writeText }, configurable: true, writable: true,
    });
    render(<TutorMarkdown>{"```\nconst x = 1;\n```"}</TutorMarkdown>);

    await user.click(screen.getByRole("button", { name: "Copy code" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(screen.getByRole("button", { name: "Copy code" })).toBeInTheDocument();
  });
});
