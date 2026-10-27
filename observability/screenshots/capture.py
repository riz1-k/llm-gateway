# /// script
# requires-python = ">=3.11"
# dependencies = ["playwright==1.64.1"]
# ///
"""Screenshots of the provisioned Switchyard dashboards.

    uv run observability/screenshots/capture.py --url http://127.0.0.1:3301 \
        --password "$GRAFANA_ADMIN_PASSWORD" [--only cost] [--suffix=-kind] [--prefix=dev-] [--range now-30m]

Drives the locally installed Google Chrome (``--channel chrome``, no browser download) or
Playwright's Chromium (``--channel chromium``). Logs in through Grafana's API, opens each dashboard
in kiosk mode, waits for the panels to finish loading and writes
observability/screenshots/<prefix><uid><suffix>.png.
"""

from __future__ import annotations

import argparse
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

DASHBOARDS = {
    "overview": "switchyard-overview",
    "cost": "switchyard-cost",
    "providers": "switchyard-providers",
}


def main() -> int:
    p = argparse.ArgumentParser()
    p.add_argument("--url", default="http://127.0.0.1:3301")
    p.add_argument("--user", default="admin")
    p.add_argument("--password", required=True)
    p.add_argument("--only", choices=sorted(DASHBOARDS), action="append")
    p.add_argument("--suffix", default="")
    p.add_argument("--prefix", default="")
    p.add_argument("--range", default="now-30m")
    p.add_argument("--channel", default="chrome")
    p.add_argument("--height", type=int, default=2100, help="viewport height (whole dashboard)")
    p.add_argument("--out", default=str(Path(__file__).resolve().parent))
    args = p.parse_args()

    out = Path(args.out)
    names = args.only or list(DASHBOARDS)
    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel=args.channel, headless=True)
        ctx = browser.new_context(
            viewport={"width": 1680, "height": args.height}, device_scale_factor=1, color_scheme="dark"
        )
        login = ctx.request.post(
            f"{args.url}/login", data={"user": args.user, "password": args.password}
        )
        if not login.ok:
            print(f"login failed: {login.status} {login.text()}", file=sys.stderr)
            return 1
        page = ctx.new_page()
        for name in names:
            uid = DASHBOARDS[name]
            page.goto(
                f"{args.url}/d/{uid}?orgId=1&from={args.range}&to=now&kiosk&refresh=",
                wait_until="networkidle",
            )
            # The viewport is tall enough for the whole dashboard, so every (lazy) panel renders;
            # then let in-flight queries settle.
            page.wait_for_selector("[data-viz-panel-key], .react-grid-item", timeout=30_000)
            page.wait_for_load_state("networkidle")
            time.sleep(3)
            path = out / f"{args.prefix}{uid}{args.suffix}.png"
            page.screenshot(path=str(path))
            print(f"wrote {path}")
        browser.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
