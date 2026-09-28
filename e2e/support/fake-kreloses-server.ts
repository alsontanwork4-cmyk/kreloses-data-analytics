/**
 * Serves the fake Kreloses (src/kreloses/testing/fake-kreloses.ts) over HTTP for the e2e suite,
 * so the app under test logs in to "Kreloses" for real without ever contacting kreloses.com.
 * Started by playwright.config.ts; the app is pointed at it with KRELOSES_BASE_URL_WWW/SEA
 * (both this one origin: the fake routes www and sea paths on the same host).
 *
 *   FAKE_KRELOSES_PORT=5123 npx tsx e2e/support/fake-kreloses-server.ts
 */
import { createServer } from "node:http";

import {
  createFakeKreloses,
  readSaleListRows,
  readSaleOverviewModels,
  type SaleListRow,
  type SaleOverviewModel,
} from "../../src/kreloses/testing/fake-kreloses";

const port = Number(process.env.FAKE_KRELOSES_PORT);
if (!Number.isInteger(port) || port <= 0) throw new Error("Set FAKE_KRELOSES_PORT");
const origin = `http://127.0.0.1:${port}`;
const fake = createFakeKreloses({ baseUrls: { www: origin, sea: origin } });

/** Test-only control endpoints (`/__e2e/…`, see ./fake-kreloses-control.ts): which sales the fake serves. */
function control(path: string, body: string): { status: number; text: string } {
  // `saleRows` / `saleOverviews` are the fake's live, mutable copies: replace their contents.
  const serve = (rows: SaleListRow[], overviews: Record<string, SaleOverviewModel>) => {
    fake.saleRows.splice(0, fake.saleRows.length, ...rows);
    for (const id of Object.keys(fake.saleOverviews)) delete fake.saleOverviews[id];
    Object.assign(fake.saleOverviews, overviews);
  };
  if (path === "/__e2e/sales") {
    const sales = JSON.parse(body) as { rows?: unknown; overviews?: unknown };
    if (!Array.isArray(sales.rows) || typeof sales.overviews !== "object" || sales.overviews === null) return { status: 400, text: "need {rows, overviews}" };
    serve(sales.rows as SaleListRow[], sales.overviews as Record<string, SaleOverviewModel>);
    return { status: 200, text: `serving ${sales.rows.length} sales` };
  }
  if (path === "/__e2e/sales/reset") {
    serve(readSaleListRows(), readSaleOverviewModels());
    return { status: 200, text: "serving the shared fixtures" };
  }
  return { status: 404, text: "unknown control endpoint" };
}

const server = createServer(async (request, response) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    if (request.method === "POST" && request.url?.startsWith("/__e2e/")) {
      const answer = control(request.url, Buffer.concat(chunks).toString("utf8"));
      response.writeHead(answer.status, { "Content-Type": "text/plain" });
      response.end(answer.text);
      return;
    }
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(request.headers)) {
      if (value !== undefined) headers[name] = Array.isArray(value) ? value.join(", ") : value;
    }
    const answer = await fake.transport(`${origin}${request.url ?? "/"}`, {
      method: request.method === "POST" ? "POST" : "GET",
      headers,
      body: chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : undefined,
      redirect: "manual",
    });
    const outgoing: Record<string, string | string[]> = {};
    answer.headers.forEach((value, name) => {
      if (name !== "set-cookie") outgoing[name] = value;
    });
    const cookies = answer.headers.getSetCookie();
    if (cookies.length > 0) outgoing["set-cookie"] = cookies;
    response.writeHead(answer.status, outgoing);
    response.end(Buffer.from(await answer.arrayBuffer()));
  } catch (error) {
    response.writeHead(500, { "Content-Type": "text/plain" });
    response.end(`fake Kreloses error: ${(error as Error).message}`);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`Fake Kreloses listening on ${origin}`);
});
