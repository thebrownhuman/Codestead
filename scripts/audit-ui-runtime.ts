import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import AxeBuilder from "@axe-core/playwright";
import { chromium, type BrowserContextOptions } from "playwright";

type AuditTarget = {
  name: string;
  path: string;
};

type AuditViewport = {
  name: string;
  width: number;
  height: number;
  reducedMotion?: BrowserContextOptions["reducedMotion"];
  textScale?: number;
};

type AuditTotals = {
  pages: number;
  horizontalOverflow: number;
  touchTargetFailures: number;
  tinyText: number;
  unlabeledControls: number;
  longAnimations: number;
  accessibilityViolations: number;
  pageErrors: number;
  consoleErrors: number;
};

const baseUrl = process.env.UI_AUDIT_BASE_URL ?? "http://127.0.0.1:3107";
const outputRoot = path.resolve(process.env.UI_AUDIT_OUTPUT ?? "test-results/ui-runtime-audit");

const targets: AuditTarget[] = [
  { name: "landing", path: "/" },
  { name: "login", path: "/login" },
  { name: "courses", path: "/courses" },
  { name: "playground", path: "/playground" },
  { name: "requests", path: "/requests" },
  { name: "review", path: "/review" },
  { name: "onboarding", path: "/onboarding" },
  { name: "admin-curriculum", path: "/admin/curriculum" },
];

const viewports: AuditViewport[] = [
  { name: "desktop-1440", width: 1440, height: 900 },
  { name: "tablet-landscape", width: 1024, height: 768 },
  { name: "phone-375", width: 375, height: 812, reducedMotion: "reduce" },
  { name: "small-phone-320", width: 320, height: 568, reducedMotion: "reduce" },
  { name: "phone-375-text-200", width: 375, height: 812, reducedMotion: "reduce", textScale: 2 },
];

async function main() {
const browser = await chromium.launch({ headless: true });
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  baseUrl,
  scope: {
    targets: targets.map((target) => target.path),
    viewports,
    note: "Local auth-bypass visual audit. Inline prose links are excluded from the 44px touch-target rule.",
  },
  results: [] as Array<Record<string, unknown>>,
};

await mkdir(outputRoot, { recursive: true });

try {
  for (const viewport of viewports) {
    const context = await browser.newContext({
      colorScheme: "dark",
      reducedMotion: viewport.reducedMotion ?? "no-preference",
      viewport: { width: viewport.width, height: viewport.height },
    });

    for (const target of targets) {
      const page = await context.newPage();
      const pageErrors: Array<{ message: string; stack: string | null }> = [];
      const consoleErrors: string[] = [];

      page.on("pageerror", (error) => pageErrors.push({ message: error.message, stack: error.stack ?? null }));
      page.on("console", (message) => {
        if (message.type() === "error") {
          consoleErrors.push(message.text());
        }
      });

      const response = await page.goto(new URL(target.path, baseUrl).toString(), {
        waitUntil: "networkidle",
        timeout: 30_000,
      });

      // tsx/esbuild preserves callback names with a tiny `__name` helper. The
      // helper is normally Node-local, so expose its no-op equivalent before
      // Playwright evaluates the serialized audit callback in the page realm.
      await page.evaluate("globalThis.__name = (target) => target;");

      if (viewport.textScale) {
        await page.evaluate((scale) => {
          document.documentElement.style.fontSize = `${scale * 100}%`;
        }, viewport.textScale);
        await page.waitForTimeout(100);
      }

      const layout = await page.evaluate(({ width, height }) => {
        const root = document.documentElement;
        const body = document.body;
        const isRendered = (element: Element) => {
          const style = getComputedStyle(element);
          const rect = element.getBoundingClientRect();
          return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
        };

        const interactive = Array.from(
          document.querySelectorAll<HTMLElement>(
            "a[href], button, input, select, textarea, summary, [role='button'], [role='link'], [tabindex]:not([tabindex='-1'])",
          ),
        ).filter(isRendered);

        const unlabeledControls = interactive.flatMap((element) => {
          const tag = element.tagName.toLowerCase();
          const type = element.getAttribute("type")?.toLowerCase();
          if (tag === "input" && type === "hidden") return [];

          const labels = "labels" in element
            ? Array.from((element as HTMLInputElement).labels ?? []).map((label) => label.textContent?.trim() ?? "")
            : [];
          const name = [
            element.getAttribute("aria-label"),
            element.getAttribute("aria-labelledby"),
            element.getAttribute("title"),
            element.textContent?.trim(),
            ...labels,
          ].find((value) => Boolean(value));

          return name
            ? []
            : [{ tag, id: element.id || null, className: element.className || null }];
        });

        const touchTargetFailures = interactive.flatMap((element) => {
          if (element.matches(":disabled, [aria-disabled='true']")) return [];
          if (element.tagName === "A" && getComputedStyle(element).display === "inline" && element.closest("p, li")) {
            return [];
          }

          // A native checkbox/radio wrapped by a label uses the label as its
          // effective pointer target. Measuring only the 17px control reports
          // a false failure even when the visible row is comfortably tappable.
          const wrappingLabel = element.matches("input[type='checkbox'], input[type='radio']")
            ? element.closest("label")
            : null;
          const elementRect = element.getBoundingClientRect();
          const isMonacoHiddenInput =
            element instanceof HTMLTextAreaElement &&
            element.classList.contains("inputarea") &&
            Boolean(element.closest(".monaco-editor")) &&
            elementRect.width <= 1 &&
            elementRect.height <= 1;
          if (isMonacoHiddenInput) return [];
          const rect = wrappingLabel && isRendered(wrappingLabel)
            ? wrappingLabel.getBoundingClientRect()
            : elementRect;
          if (rect.width >= 44 && rect.height >= 44) return [];

          return [{
            tag: element.tagName.toLowerCase(),
            text: (element.getAttribute("aria-label") || element.textContent || "").trim().slice(0, 80),
            width: Number(rect.width.toFixed(2)),
            height: Number(rect.height.toFixed(2)),
            className: typeof element.className === "string" ? element.className : null,
          }];
        });

        const tinyText = Array.from(document.querySelectorAll<HTMLElement>("p, li, label, small, span"))
          .filter(isRendered)
          .flatMap((element) => {
            if (element.children.length > 0 || !element.textContent?.trim()) return [];
            const size = Number.parseFloat(getComputedStyle(element).fontSize);
            return size >= 12
              ? []
              : [{ text: element.textContent.trim().slice(0, 100), fontSize: size, className: element.className || null }];
          });

        const longAnimations = Array.from(document.querySelectorAll<HTMLElement>("*"))
          .filter(isRendered)
          .flatMap((element) => {
            const style = getComputedStyle(element);
            const durations = [...style.animationDuration.split(","), ...style.transitionDuration.split(",")]
              .map((value) => value.trim())
              .map((value) => value.endsWith("ms") ? Number.parseFloat(value) : Number.parseFloat(value) * 1000)
              .filter(Number.isFinite);
            const maxDurationMs = Math.max(0, ...durations);
            if (maxDurationMs <= 500 && style.animationIterationCount !== "infinite") return [];
            return [{
              tag: element.tagName.toLowerCase(),
              className: typeof element.className === "string" ? element.className : null,
              maxDurationMs,
              iterationCount: style.animationIterationCount,
            }];
          });

        return {
          viewport: { width, height },
          documentSize: { width: root.scrollWidth, height: root.scrollHeight },
          horizontalOverflow: Math.max(root.scrollWidth, body.scrollWidth) > width + 1,
          overflowPixels: Math.max(0, Math.max(root.scrollWidth, body.scrollWidth) - width),
          interactiveCount: interactive.length,
          unlabeledControls,
          touchTargetFailures,
          tinyText,
          longAnimations,
        };
      }, { width: viewport.width, height: viewport.height });

      const axe = await new AxeBuilder({ page })
        .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
        .analyze();

      const screenshot = path.join(outputRoot, `${target.name}--${viewport.name}.png`);
      await page.screenshot({ path: screenshot, fullPage: true });

      report.results.push({
        target,
        viewport,
        finalUrl: page.url(),
        status: response?.status() ?? null,
        title: await page.title(),
        layout,
        accessibilityViolations: axe.violations.map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          help: violation.help,
          nodes: violation.nodes.length,
        })),
        pageErrors,
        consoleErrors,
        screenshot: path.relative(process.cwd(), screenshot).replaceAll("\\", "/"),
      });

      await page.close();
    }

    await context.close();
  }
} finally {
  await browser.close();
}

const reportPath = path.join(outputRoot, "report.json");
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });

const totals = report.results.reduce<AuditTotals>(
  (summary, result) => {
    const layout = result.layout as {
      horizontalOverflow: boolean;
      touchTargetFailures: unknown[];
      tinyText: unknown[];
      unlabeledControls: unknown[];
      longAnimations: unknown[];
    };
    summary.horizontalOverflow += Number(layout.horizontalOverflow);
    summary.touchTargetFailures += layout.touchTargetFailures.length;
    summary.tinyText += layout.tinyText.length;
    summary.unlabeledControls += layout.unlabeledControls.length;
    summary.longAnimations += layout.longAnimations.length;
    summary.accessibilityViolations += (result.accessibilityViolations as unknown[]).length;
    summary.pageErrors += (result.pageErrors as unknown[]).length;
    summary.consoleErrors += (result.consoleErrors as unknown[]).length;
    return summary;
  },
  {
    pages: report.results.length,
    horizontalOverflow: 0,
    touchTargetFailures: 0,
    tinyText: 0,
    unlabeledControls: 0,
    longAnimations: 0,
    accessibilityViolations: 0,
    pageErrors: 0,
    consoleErrors: 0,
  },
);

console.log(JSON.stringify({ reportPath, totals }, null, 2));
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
