/**
 * The Reader's only way out to the network: a fetch-shaped function. Production uses global
 * `fetch`; tests pass the fake Kreloses (`./testing/fake-kreloses`) so no test ever contacts the
 * real site. Redirects are always handled by the session (`redirect: "manual"`), never by the
 * transport, so cookies can be applied per hop.
 */
export interface TransportRequest {
  method: "GET" | "POST";
  headers: Record<string, string>;
  body?: string;
  redirect: "manual";
  signal?: AbortSignal;
}

export type Transport = (url: string, init: TransportRequest) => Promise<Response>;

export const fetchTransport: Transport = (url, init) => fetch(url, init);
