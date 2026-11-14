import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/db";
import { authenticateClient, bindInternalClient } from "@/lib/auth/client";
import { encryptJson, decryptJson } from "@/lib/crypto";
import { readJson, jsonError } from "@/lib/http";
import { parseResponsesRequest, RequestValidationError } from "@/lib/validation";
import { responsesTools, type ResponsesTools } from "@/lib/responses-tools";
import { AGENT_TURN_INSTRUCTIONS, agentTurnChat, agentTurnTools } from "@/lib/providers/agent-turn";
import type { CanonicalChat } from "@/lib/providers/openai";
import { POST as chatCompletions } from "@/app/v1/chat/completions/route";
export const runtime = "nodejs";
export const maxDuration = 300;
type ChatMessage = { role: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string; name?: string };
function convertInput(input: unknown, tools: ResponsesTools): ChatMessage[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) throw new Error("input must be a string or array of items");
  const out: ChatMessage[] = [];
  for (const item of input as any[]) {
    if (!item || typeof item !== "object") throw new Error("Invalid input item");
    if (["system","developer","user","assistant"].includes(item.role) && (item.type === "message" || item.role)) { const parts=Array.isArray(item.content)?item.content.map((p:any)=>p?.type==="input_text"||p?.type==="output_text"?{type:"text",text:p.text}:p?.type==="input_image"?{type:"image_url",image_url:p.image_url}:p):item.content;out.push({ role: item.role, content: parts ?? "" }); continue; }
    if (item.type === "function_call") { out.push({ role: "assistant", content: null, tool_calls: [{ id: item.call_id, type: "function", function: { name: tools.encode(item.name, item.namespace), arguments: item.arguments } }] }); continue; }
    if (item.type === "function_call_output") {
      let output = item.output;
      if (Array.isArray(output)) {
        if (output.some((part:any)=>!["input_text","output_text","text"].includes(part?.type)||typeof part.text!=="string")) throw new Error("Invalid input: tool outputs support text parts only");
        output = output.map((part:any)=>part.text).join("\n");
      }
      out.push({ role: "tool", tool_call_id: item.call_id, content: output }); continue;
    }
    throw new Error(`Unsupported Responses input item: ${String(item.type || "unknown")}`);
  }
  return out;
}
function responseObject(id: string, model: string, message: any, usage: any, created: number,input:unknown,tools:ResponsesTools,metadata?:Record<string,string>) {
  const output: any[] = [];
  if (message?.content != null) output.push({ id: `msg_${id}`, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: message.content, annotations: [] }] });
  for (const c of message?.tool_calls || []) {
    const identity = tools.decode(c.function.name);
    if (!identity) throw new Error("The upstream returned an undeclared function");
    output.push({ id: `fc_${c.id}`, type: "function_call", status: "completed", call_id: c.id, ...identity, arguments: c.function.arguments });
  }
  return { id, object: "response", created_at: created, status: "completed", error: null, incomplete_details: null, model, input, metadata:metadata||{}, output, output_text: typeof message?.content === "string" ? message.content : "", usage: usage ? { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0, total_tokens: usage.total_tokens ?? 0 } : null, store: true };
}

function streamResponses(chat: Response, options: { id: string; model: string; input: unknown; metadata?: Record<string,string>; created: number; store: boolean; messages: ChatMessage[]; ownerId: string; tools: ResponsesTools }) {
  const encoder = new TextEncoder();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let closed = false;
  let sequence = 0;
  const responseId = options.id;
  const send = (controller: ReadableStreamDefaultController<Uint8Array>, type: string, fields: Record<string, unknown>) => {
    if (closed) return;
    const payload = { type, sequence_number: sequence++, ...fields };
    controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`));
  };
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const base = { id: responseId, object: "response", created_at: options.created, status: "in_progress", error: null, incomplete_details: null, model: options.model, input: options.input, metadata: options.metadata || {}, output: [], output_text: "", usage: null, store: options.store };
      send(controller, "response.created", { response: base });
      send(controller, "response.in_progress", { response: base });
      const heartbeat = setInterval(() => { if (!closed) controller.enqueue(encoder.encode(": keepalive\n\n")); }, 10_000);
      void (async () => {
        try {
          if (!chat.body) throw new Error("The streamed Chat response has no body.");
          reader = chat.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          let content = "";
          let usage: any;
          let finishReason: string | null = null;
          let sawDone = false;
          let messageAdded = false;
          let messageFinished = false;
          let messageOutputIndex = -1;
          let nextOutputIndex = 0;
          const tools = new Map<number, { id: string; name: string; arguments: string; itemId: string; outputIndex: number; added: boolean }>();
          const itemEvents = (chunk: any) => {
            const choice = chunk?.choices?.[0];
            const text = choice?.delta?.content;
            if (typeof text === "string" && text) {
              if (!messageAdded) {
                messageAdded = true;
                messageOutputIndex = nextOutputIndex++;
                send(controller, "response.output_item.added", { output_index: messageOutputIndex, item: { id: `msg_${responseId}`, type: "message", status: "in_progress", role: "assistant", content: [] } });
                send(controller, "response.content_part.added", { item_id: `msg_${responseId}`, output_index: messageOutputIndex, content_index: 0, part: { type: "output_text", text: "", annotations: [] } });
              }
              content += text;
              send(controller, "response.output_text.delta", { item_id: `msg_${responseId}`, output_index: messageOutputIndex, content_index: 0, delta: text });
            }
            for (const call of choice?.delta?.tool_calls || []) {
              const index = Number(call.index);
              if (!Number.isInteger(index) || index < 0) throw new Error("The upstream returned an invalid tool-call index.");
              const prior = tools.get(index) || { id: "", name: "", arguments: "", itemId: "", outputIndex: 0, added: false };
              if (call.id) prior.id = call.id;
              if (call.function?.name) prior.name += call.function.name;
              if (call.function?.arguments) prior.arguments += call.function.arguments;
              if (!prior.id) throw new Error("The upstream tool call has no stable call ID.");
              const identity = options.tools.decode(prior.name);
              const wasAdded = prior.added;
              if (!prior.added && identity && prior.name) {
                prior.added = true;
                prior.itemId = `fc_${prior.id}`;
                prior.outputIndex = nextOutputIndex++;
                send(controller, "response.output_item.added", { output_index: prior.outputIndex, item: { id: prior.itemId, type: "function_call", status: "in_progress", call_id: prior.id, ...identity, arguments: "" } });
              }
              const delta = wasAdded ? call.function?.arguments : prior.arguments;
              if (prior.added && delta) send(controller, "response.function_call_arguments.delta", { item_id: prior.itemId, output_index: prior.outputIndex, delta });
              tools.set(index, prior);
            }
            if (choice?.finish_reason) finishReason = choice.finish_reason;
            if (chunk?.usage) usage = chunk.usage;
          };
          const parseFrame = (frame: string) => {
            const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
            if (!data) return;
            if (data === "[DONE]") { sawDone = true; return; }
            const parsed = JSON.parse(data);
            if (parsed?.error) throw new Error(typeof parsed.error.message === "string" ? parsed.error.message : "The upstream stream failed.");
            itemEvents(parsed);
          };
          while (!closed) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const frames = buffer.split(/\r?\n\r?\n/);
            buffer = frames.pop() || "";
            for (const frame of frames) parseFrame(frame);
          }
          buffer += decoder.decode();
          if (buffer.trim()) parseFrame(buffer);
          if (closed) return;
          if (!sawDone || !finishReason) throw new Error("The upstream stream ended before a successful finish event.");
          const message = { role: "assistant", content: content || null, ...(tools.size ? { tool_calls: [...tools.entries()].sort(([a],[b])=>a-b).map(([,tool])=>({ id: tool.id, type: "function", function: { name: tool.name, arguments: tool.arguments } })) } : {}) };
          if (message.content !== null && !messageFinished) {
            messageFinished = true;
            const item = { id: `msg_${responseId}`, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: content, annotations: [] }] };
            send(controller, "response.output_text.done", { item_id: item.id, output_index: messageOutputIndex, content_index: 0, text: content });
            send(controller, "response.content_part.done", { item_id: item.id, output_index: messageOutputIndex, content_index: 0, part: item.content[0] });
            send(controller, "response.output_item.done", { output_index: messageOutputIndex, item });
          }
          for (const tool of tools.values()) {
            const identity = options.tools.decode(tool.name);
            if (!tool.added || !identity) throw new Error("The upstream returned an undeclared function");
            const item = { id: tool.itemId, type: "function_call", status: "completed", call_id: tool.id, ...identity, arguments: tool.arguments };
            send(controller, "response.function_call_arguments.done", { item_id: item.id, output_index: tool.outputIndex, arguments: tool.arguments });
            send(controller, "response.output_item.done", { output_index: tool.outputIndex, item });
          }
          const complete: any = responseObject(responseId, options.model, message, usage, options.created, options.input, options.tools, options.metadata);
          complete.store = options.store;
          const outputByIndex: any[] = [];
          if (message.content !== null) outputByIndex[messageOutputIndex] = complete.output.find((item: any) => item.type === "message");
          for (const tool of tools.values()) outputByIndex[tool.outputIndex] = complete.output.find((item: any) => item.type === "function_call" && item.call_id === tool.id);
          complete.output = outputByIndex.filter(Boolean);
          if (finishReason === "length") {
            complete.status = "incomplete";
            complete.incomplete_details = { reason: "max_output_tokens" };
          }
          if (options.store) {
            const expiresAt = new Date(Date.now()+86400000);
            const snapshot = [...options.messages, message];
            const payload = encryptJson({ messages: snapshot, response: complete }, `${options.ownerId}:${responseId}:response:v1:${expiresAt.toISOString()}`);
            await (await getDb()).collection("responses").insertOne({ responseId, ownerId: options.ownerId, createdAt: new Date(), expiresAt, model: options.model, payload, expiresAtBytes: payload.body.length });
          }
          send(controller, complete.status === "incomplete" ? "response.incomplete" : "response.completed", { response: complete });
          closed = true;
          controller.close();
        } catch (error) {
          if (!closed) {
            const failed = { id: responseId, object: "response", created_at: options.created, status: "failed", error: { type: "server_error", code: "upstream_stream_failed", message: error instanceof Error ? error.message : "The upstream response failed." }, incomplete_details: null, model: options.model, input: options.input, metadata: options.metadata || {}, output: [], output_text: "", usage: null, store: false };
            send(controller, "response.failed", { response: failed });
            closed = true;
            controller.close();
          }
        } finally {
          clearInterval(heartbeat);
          await reader?.cancel().catch(() => undefined);
        }
      })();
    },
    async cancel() { closed = true; await reader?.cancel().catch(() => undefined); },
  });
  return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", "x-request-id": responseId, "x-freerouter-resolved-model": chat.headers.get("x-freerouter-resolved-model") || options.model } });
}
export async function POST(request: Request) {
  const rid = request.headers.get("x-request-id") || `fr_${randomUUID()}`;
  let body: any; try { body = await readJson(request); } catch (e) { const m = e instanceof Error ? e.message : "Invalid JSON"; return jsonError(m === "body_too_large" ? 413 : m==="unsupported_content_type"||m==="unsupported_encoding"?415:400, m, "invalid_request", rid); }
  try { body = parseResponsesRequest(body); } catch (e) {
    if (e instanceof RequestValidationError) return jsonError(400, e.message, e.kind === "unsupported_parameter" ? "unsupported_parameter" : "invalid_request", rid, e.param);
    return jsonError(400, e instanceof Error ? e.message : "Invalid request", "invalid_request", rid);
  }
  const auth = await authenticateClient(request,"responses",body.model); if ("error" in auth) return jsonError(auth.error === "invalid_api_key"?401:403,"API key cannot access this request",String(auth.error),rid);
  const store = body.store !== false; let history: ChatMessage[] = [];
  try {
    if (body.previous_response_id) {
      if (typeof body.previous_response_id !== "string") throw new Error("Invalid previous_response_id");
      const db = await getDb(); const record = await db.collection<any>("responses").findOne({ responseId: body.previous_response_id, ownerId: String(auth.key._id), expiresAt: { $gt: new Date() } });
      if (!record) return jsonError(404,"Response is unavailable","response_not_found",rid);
      const data = decryptJson<{ messages: ChatMessage[] }>(record.payload, `${record.ownerId}:${record.responseId}:response:v1:${new Date(record.expiresAt).toISOString()}`); history = data.messages;
    }
    const agentControl = body.stream === true && body.model === "nvidia/nvidia/nemotron-3.5-super-vl-120b-a12b"
      && body.tools?.length && body.include?.includes("reasoning.encrypted_content")
      && (body.tool_choice === undefined || body.tool_choice === "auto")
      && (!body.text?.format || body.text.format.type === "text")
      ? agentTurnTools(body.tools) : undefined;
    const tools = responsesTools(agentControl ? [...body.tools, agentControl] : body.tools);
    const fresh = convertInput(body.input ?? "", tools);
    const messages: ChatMessage[] = [...history]; if (body.instructions) messages.push({ role: "developer", content: body.instructions }); messages.push(...fresh);
    const toolChoice = tools.choice(body.tool_choice);
    const streaming = body.stream === true;
    const chatBody = { model: body.model, messages, stream: streaming, ...(streaming?{stream_options:{include_usage:true}}:{}), max_completion_tokens: body.max_output_tokens, tools: tools.tools, tool_choice: toolChoice, parallel_tool_calls: body.parallel_tool_calls, response_format: body.text?.format ? body.text.format.type === "json_schema" ? {type:"json_schema",json_schema:{name:body.text.format.name,strict:body.text.format.strict,schema:body.text.format.schema}} : {type:body.text.format.type} : undefined, reasoning_effort: body.reasoning?.effort, prompt_cache_key: body.prompt_cache_key, store: false };
    const dispatch = async (input: CanonicalChat, signal = request.signal) => {
      const internal = new Request("https://freerouter.local/v1/chat/completions", { method:"POST", headers:{authorization:request.headers.get("authorization")||"", "content-type":"application/json", "x-request-id":rid}, body:JSON.stringify(input), signal });
      bindInternalClient(internal, auth.key);
      return chatCompletions(internal);
    };
    const chat = agentControl ? await agentTurnChat({ body: { ...chatBody, messages: [...messages, { role: "developer", content: `${AGENT_TURN_INSTRUCTIONS}\nPrivate runtime namespace: ${agentControl.name}.` }] }, progress: tools.encode("progress", agentControl.name), finish: tools.encode("finish", agentControl.name), signal: request.signal, dispatch }) : await dispatch(chatBody);
    if (!chat.ok) return new Response(await chat.text(),{status:chat.status,headers:{"content-type":"application/json","cache-control":"no-store","x-request-id":rid}});
    if (streaming) {
      const id = `resp_${randomUUID().replaceAll("-","")}`;
      return streamResponses(chat, { id, model: body.model, input: body.input, metadata: body.metadata, created: Math.floor(Date.now()/1000), store, messages, ownerId: String(auth.key._id), tools });
    }
    const result = await chat.json() as any; const id = `resp_${randomUUID().replaceAll("-","")}`; const created = Math.floor(Date.now()/1000); const response = responseObject(id,body.model,result.choices?.[0]?.message,result.usage,created,body.input,tools,body.metadata);
    if (store) { const expiresAt = new Date(Date.now()+86400000); const snapshot = [...messages, ...(result.choices?.[0]?.message ? [{role:"assistant",...result.choices[0].message}] : [])]; const payload=encryptJson({messages:snapshot,response},`${String(auth.key._id)}:${id}:response:v1:${expiresAt.toISOString()}`); await (await getDb()).collection("responses").insertOne({responseId:id,ownerId:String(auth.key._id),createdAt:new Date(),expiresAt,model:body.model,payload,expiresAtBytes:payload.body.length}); }
    response.store=store;
    return Response.json(response,{headers:{"cache-control":"no-store","x-request-id":rid,"x-freerouter-resolved-model":chat.headers.get("x-freerouter-resolved-model")||body.model}});
  } catch(e) {if(e instanceof RequestValidationError)return jsonError(400,e.message,e.kind==="unsupported_parameter"?"unsupported_parameter":"invalid_request",rid,e.param);const message=e instanceof Error?e.message:"Invalid request";if(message.includes("4 MiB")||message.includes("8 MiB"))return jsonError(413,message,"state_too_large",rid);if(message.includes("previous_response_id")||message.includes("Unsupported Responses input")||message.includes("Invalid input")||message.includes("input must"))return jsonError(400,message,"invalid_request",rid);return jsonError(503,"Responses state or persistence operation failed","response_state_unavailable",rid); }
}

export async function GET(request: Request, ctx: {params: Promise<Record<string,string>>}) {
  const auth=await authenticateClient(request,"responses");if("error" in auth)return jsonError(401,"Invalid API key","invalid_api_key");const id=new URL(request.url).pathname.split("/").filter(Boolean).at(-1)!;
  try {const rec=await(await getDb()).collection<any>("responses").findOne({responseId:id,ownerId:String(auth.key._id),expiresAt:{$gt:new Date()}});if(!rec)return jsonError(404,"Response is unavailable","response_not_found");const data=decryptJson<any>(rec.payload,`${rec.ownerId}:${rec.responseId}:response:v1:${new Date(rec.expiresAt).toISOString()}`);return Response.json(data.response,{headers:{"cache-control":"no-store"}});}catch{return jsonError(404,"Response is unavailable","response_not_found");}
}
