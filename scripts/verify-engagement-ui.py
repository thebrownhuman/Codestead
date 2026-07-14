"""Independent browser QA for the engagement and accessibility upgrade.

Run through the webapp-testing server helper so the disposable Next server is
always stopped, even when a visual assertion fails.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from playwright.sync_api import Page, sync_playwright


def assert_no_overflow(page: Page, label: str) -> None:
    geometry = page.evaluate(
        """() => ({
          scrollWidth: document.documentElement.scrollWidth,
          clientWidth: document.documentElement.clientWidth,
        })"""
    )
    if geometry["scrollWidth"] > geometry["clientWidth"] + 1:
        raise AssertionError(f"{label}: horizontal overflow {geometry}")


def add_preferences(context, *, text_size: str, motion: str, theme: str) -> None:
    value = json.dumps(
        {
            "version": 1,
            "textSize": text_size,
            "motion": motion,
            "interfaceTheme": theme,
            "codeEditorFont": "14",
        }
    )
    context.add_init_script(
        f"localStorage.setItem('learncoding.accessibility-preferences.v1', {json.dumps(value)});"
    )


def visit(page: Page, url: str) -> None:
    page.goto(url, wait_until="networkidle", timeout=90_000)
    page.locator("body").wait_for(state="visible")


def verify_mobile_chrome(browser, base_url: str, artifacts: Path) -> None:
    for width, height in ((320, 568), (375, 812)):
        for text_size in ("150", "200"):
            context = browser.new_context(viewport={"width": width, "height": height})
            add_preferences(context, text_size=text_size, motion="reduce", theme="dark")
            page = context.new_page()
            visit(page, f"{base_url}/learn")
            geometry = page.evaluate(
                """() => {
                  const header = document.querySelector('header');
                  const main = document.querySelector('#main-content');
                  const nav = document.querySelector('nav[aria-label="Mobile navigation"]');
                  if (!(header instanceof HTMLElement) || !(main instanceof HTMLElement) || !(nav instanceof HTMLElement)) {
                    throw new Error('Mobile shell structure is missing');
                  }
                  const headerBox = header.getBoundingClientRect();
                  const mainBox = main.getBoundingClientRect();
                  const navBox = nav.getBoundingClientRect();
                  return {
                    headerBottom: headerBox.bottom,
                    mainTop: mainBox.top,
                    navLeft: navBox.left,
                    navRight: navBox.right,
                    navBottom: navBox.bottom,
                    navHeight: navBox.height,
                    mainPaddingBottom: parseFloat(getComputedStyle(main).paddingBottom),
                    routeAnimation: getComputedStyle(document.querySelector('[data-route-stage]')).animationName,
                  };
                }"""
            )
            if geometry["mainTop"] < geometry["headerBottom"] - 1:
                raise AssertionError(f"{width}px/{text_size}%: header overlaps main {geometry}")
            if geometry["navLeft"] < 0 or geometry["navRight"] > width + 1:
                raise AssertionError(f"{width}px/{text_size}%: navigation leaves viewport {geometry}")
            bottom_gap = height - geometry["navBottom"]
            if geometry["mainPaddingBottom"] < geometry["navHeight"] + bottom_gap:
                raise AssertionError(f"{width}px/{text_size}%: main lacks navigation clearance {geometry}")
            if geometry["routeAnimation"] != "none":
                raise AssertionError(f"{width}px/{text_size}%: reduced motion kept route animation")
            assert_no_overflow(page, f"{width}px/{text_size}% learning home")
            page.screenshot(
                path=str(artifacts / f"learn-{width}px-{text_size}pct-dark.png"),
                full_page=True,
            )
            context.close()


def verify_route_focus_and_roadmap(browser, base_url: str, artifacts: Path) -> None:
    context = browser.new_context(viewport={"width": 1440, "height": 1000})
    add_preferences(context, text_size="100", motion="normal", theme="light")
    page = context.new_page()
    visit(page, f"{base_url}/learn")
    page.locator('nav[aria-label="Learner navigation"] a[href="/roadmap"]').click()
    page.wait_for_url(f"{base_url}/roadmap")
    page.wait_for_function("document.activeElement?.id === 'main-content'")
    page.get_by_role("region", name="Interactive course journey").wait_for()
    first_explorer = page.locator("details").first
    first_explorer.locator("summary").click()
    if first_explorer.get_attribute("open") is None:
        raise AssertionError("Roadmap module-level explorer did not open")
    assert_no_overflow(page, "desktop roadmap")
    page.screenshot(path=str(artifacts / "roadmap-desktop-light.png"), full_page=True)
    context.close()


def verify_contrast_review(browser, base_url: str, artifacts: Path) -> None:
    context = browser.new_context(viewport={"width": 1024, "height": 900})
    add_preferences(context, text_size="115", motion="reduce", theme="contrast")
    page = context.new_page()
    visit(page, f"{base_url}/review")
    page.get_by_role("heading", name="Review what is almost slipping.").wait_for()
    root_state = page.evaluate(
        """() => ({
          theme: document.documentElement.dataset.interfaceTheme,
          contrast: document.documentElement.dataset.contrast,
          motion: document.documentElement.dataset.motion,
        })"""
    )
    if root_state != {"theme": "contrast", "contrast": "more", "motion": "reduce"}:
        raise AssertionError(f"Accessibility preferences were not applied: {root_state}")
    assert_no_overflow(page, "high-contrast review")
    page.screenshot(path=str(artifacts / "review-high-contrast.png"), full_page=True)
    context.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--base-url", default="http://127.0.0.1:3417")
    parser.add_argument(
        "--chrome",
        default=r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    )
    args = parser.parse_args()

    artifacts = Path("test-artifacts") / "engagement-ui"
    artifacts.mkdir(parents=True, exist_ok=True)

    with sync_playwright() as playwright:
        browser = playwright.chromium.launch(headless=True, executable_path=args.chrome)
        try:
            verify_mobile_chrome(browser, args.base_url, artifacts)
            verify_route_focus_and_roadmap(browser, args.base_url, artifacts)
            verify_contrast_review(browser, args.base_url, artifacts)
        finally:
            browser.close()

    print("Engagement browser QA passed: 4 mobile matrices, route focus, roadmap interaction, and high contrast.")


if __name__ == "__main__":
    main()
