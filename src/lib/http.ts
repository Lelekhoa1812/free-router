import { randomUUID } from "node:crypto";
export function requestId(request: Request) { return request.headers.get("x-request-id")?.slice(0, 100) || `fr_${randomUUID()}`; }
export function jsonError(status: number, message: string, code: string, id?: string, param: string | null = null) { return Response.json({ error: { message, type: status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : status >= 500 ? "server_error" : "invalid_request_error", param, code } }, { status, headers: { "cache-control": "no-store", ...(status===429?{"retry-after":"60"}:{}), ...(id ? { "x-request-id": id } : {}) } }); }
export function sameOrigin(request:Request){const origin=request.headers.get("origin");if(origin){try{return new URL(origin).origin===new URL(request.url).origin}catch{return false}}return request.headers.get("sec-fetch-site")!=="cross-site";}
export async function readJson(request: Request, max = 4 * 1024 * 1024): Promise<unknown> {
  if (!(request.headers.get("content-type") || "").toLowerCase().includes("application/json")) throw new Error("unsupported_content_type");
  const encoding=request.headers.get("content-encoding");if(encoding&&encoding.toLowerCase()!=="identity")throw new Error("unsupported_encoding");
  const reader = request.body?.getReader(); if (!reader) throw new Error("invalid_json");
  let size = 0; const parts: Uint8Array[] = [];
  while (true) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > max) throw new Error("body_too_large"); parts.push(value); }
  const value=JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts.map(p => Buffer.from(p)))));
  const validate=(x:any,depth:number):void=>{if(depth>64)throw new Error("json_too_deep");if(typeof x==="number"&&!Number.isFinite(x))throw new Error("nonfinite_number");if(x&&typeof x==="object")for(const v of Array.isArray(x)?x:Object.values(x))validate(v,depth+1)};validate(value,0);return value;
}
