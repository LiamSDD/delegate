import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { type LookupAddress } from "node:dns";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import { createBrotliDecompress, createGunzip, createInflate } from "node:zlib";

import { type ResolveDns } from "./fetch";
import { classifyAddress } from "./ip";

export interface PinnedFetchOptions {
  isAllowedAddress?: (address: string) => boolean;
}

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

function decoded(response: IncomingMessage): Readable {
  const encoding = (response.headers["content-encoding"] ?? "").trim().toLowerCase();
  if (encoding === "gzip" || encoding === "x-gzip") return response.pipe(createGunzip());
  if (encoding === "deflate") return response.pipe(createInflate());
  if (encoding === "br") return response.pipe(createBrotliDecompress());
  return response;
}

function responseHeaders(response: IncomingMessage, decodedBody: boolean): Headers {
  const headers = new Headers();
  const raw = response.rawHeaders;
  for (let index = 0; index + 1 < raw.length; index += 2) {
    const name = raw[index] ?? "";
    const value = raw[index + 1] ?? "";
    const lower = name.toLowerCase();
    if (decodedBody && (lower === "content-encoding" || lower === "content-length")) continue;
    try {
      headers.append(name, value);
    } catch {
      continue;
    }
  }
  return headers;
}

export function createPinnedFetch(
  resolveDns: ResolveDns,
  options: PinnedFetchOptions = {},
): typeof fetch {
  const allowed =
    options.isAllowedAddress ?? ((address: string) => classifyAddress(address).allowed);
  const lookup = (
    hostname: string,
    lookupOptions: { all?: boolean | undefined },
    callback: LookupCallback,
  ) => {
    resolveDns(hostname).then(
      (addresses) => {
        if (addresses.length === 0) {
          callback(
            Object.assign(new Error(`${hostname} has no addresses`), { code: "ENOTFOUND" }),
            "",
          );
          return;
        }
        const blocked = addresses.find((address) => !allowed(address));
        if (blocked !== undefined) {
          callback(
            Object.assign(new Error(`${hostname} resolves to a blocked address`), {
              code: "EBLOCKED",
            }),
            "",
          );
          return;
        }
        const entries = addresses.map((address) => ({
          address,
          family: isIP(address) === 6 ? 6 : 4,
        }));
        if (lookupOptions.all === true) {
          callback(null, entries);
          return;
        }
        const first = entries[0];
        callback(null, first?.address ?? "", first?.family ?? 4);
      },
      (error: unknown) => {
        callback(
          Object.assign(new Error(error instanceof Error ? error.message : "DNS lookup failed"), {
            code: "ENOTFOUND",
          }),
          "",
        );
      },
    );
  };

  return (input, init) =>
    new Promise<Response>((resolve, reject) => {
      const url = new URL(
        input instanceof Request ? input.url : input instanceof URL ? input.href : input,
      );
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        reject(new Error(`Unsupported scheme ${url.protocol}`));
        return;
      }
      if (init?.signal?.aborted === true) {
        reject(new Error("aborted"));
        return;
      }
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      headers["accept-encoding"] = "gzip, deflate, br";
      const send = url.protocol === "https:" ? httpsRequest : httpRequest;
      const request = send(
        url,
        {
          method: init?.method ?? "GET",
          headers,
          lookup,
          ...(init?.signal === undefined || init.signal === null ? {} : { signal: init.signal }),
        },
        (response) => {
          const status = response.statusCode ?? 502;
          const nullBody =
            NULL_BODY_STATUSES.has(status) || (init?.method ?? "GET").toUpperCase() === "HEAD";
          const stream = nullBody ? undefined : decoded(response);
          if (nullBody) response.resume();
          const body =
            stream === undefined ? null : (Readable.toWeb(stream) as ReadableStream<Uint8Array>);
          try {
            resolve(
              new Response(body, {
                status: status < 200 || status > 599 ? 502 : status,
                statusText: response.statusMessage ?? "",
                headers: responseHeaders(response, stream !== undefined && stream !== response),
              }),
            );
          } catch (error) {
            reject(error instanceof Error ? error : new Error("Invalid response"));
          }
        },
      );
      request.on("error", (error) => {
        reject(error);
      });
      const body = init?.body;
      if (body === undefined || body === null) request.end();
      else if (typeof body === "string" || body instanceof Uint8Array) request.end(body);
      else {
        request.destroy();
        reject(new Error("Unsupported request body type"));
      }
    });
}
