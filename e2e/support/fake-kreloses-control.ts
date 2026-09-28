/**
 * Lets a spec choose which sales the e2e fake Kreloses (./fake-kreloses-server.ts) serves, e.g.
 * sales dated relative to today (the Daily page defaults to yesterday). Test-only endpoints on the
 * fake's own loopback port:
 *
 *   POST /__e2e/sales        {rows, overviews}  serve exactly these Sale List rows and invoice pages
 *   POST /__e2e/sales/reset                     back to the shared fixtures (sale-list-rows.json, sale-overviews.json)
 *
 * The suite runs one spec at a time (workers: 1), so a spec that replaces the sales must restore
 * them in `afterAll` (other specs expect the shared fixtures). No fake import here: Playwright
 * specs load this file under their CommonJS transform.
 */
import type { SaleListRow, SaleOverviewModel } from "../../src/kreloses/testing/fake-kreloses";

function fakeUrl(path: string): string {
  const port = process.env.E2E_KRELOSES_PORT;
  if (!port) throw new Error("E2E_KRELOSES_PORT is not set; run the suite with `npm run test:e2e`");
  return `http://127.0.0.1:${port}${path}`;
}

async function post(path: string, body?: unknown): Promise<void> {
  const response = await fetch(fakeUrl(path), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`fake Kreloses ${path}: HTTP ${response.status} ${await response.text()}`);
}

/** The fake serves exactly these sales (Sale List rows + invoice page models by sale id) until `restoreFixtureSales()`. */
export async function serveSales(sales: { rows: SaleListRow[]; overviews: Record<string, SaleOverviewModel> }): Promise<void> {
  await post("/__e2e/sales", sales);
}

/** The fake serves the shared synthetic fixtures again. */
export async function restoreFixtureSales(): Promise<void> {
  await post("/__e2e/sales/reset");
}
