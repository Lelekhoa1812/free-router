import { randomUUID } from "node:crypto";
import { ObjectId } from "mongodb";
import { getDb } from "@/lib/db";
import { authenticateClient } from "@/lib/auth/client";
import { encryptJson, decryptJson } from "@/lib/crypto";
import { readJson, jsonError } from "@/lib/http";
import { POST as chatCompletions } from "@/app/v1/chat/completions/route";
export const runtime = "nodejs";
export const maxDuration = 300;
type ChatMessage = { role: string; content?: unknown; tool_calls?: unknown[]; tool_call_id?: string; name?: string };
function convertInput(input: unknown): ChatMessage[] {
  if (typeof input === "string") return [{ role: "user", content: input }];
  if (!Array.isArray(input)) throw new Error("input must be a string or array of items");
  const out: ChatMessage[] = [];
  for (const item of input as any[]) {
    if (!item || typeof item !== "object") throw new Error("Invalid input item");
    if (["system","developer","user","assistant"].includes(item.role) && (item.type === "message" || item.role)) { const parts=Array.isArray(item.content)?item.content.map((p:any)=>p?.type==="input_text"?{type:"text",text:p.text}:p?.type==="input_image"?{type:"image_url",image_url:p.image_url}:p):item.content;out.push({ role: item.role, content: parts ?? "" }); continue; }
    if (item.type === "function_call") { out.push({ role: "assistant", content: null, tool_calls: [{ id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } }] }); continue; }
    if (item.type === "function_call_output") { out.push({ role: "tool", tool_call_id: item.call_id, content: item.output }); continue; }
    throw new Error(`Unsupported Responses input item: ${String(item.type || "unknown")}`);
  }
  return out;
}
function responseObject(id: string, model: string, message: any, usage: any, created: number,input:unknown,metadata?:Record<string,string>) {
  const output: any[] = [];
  if (message?.content != null) output.push({ id: `msg_${id}`, type: "message", status: "completed", role: "assistant", content: [{ type: "output_text", text: message.content, annotations: [] }] });
  for (const c of message?.tool_calls || []) output.push({ id: `fc_${c.id}`, type: "function_call", status: "completed", call_id: c.id, name: c.function.name, arguments: c.function.arguments });
  return { id, object: "response", created_at: created, status: "completed", error: null, incomplete_details: null, model, input, metadata:metadata||{}, output, output_text: typeof message?.content === "string" ? message.content : "", usage: usage ? { input_tokens: usage.prompt_tokens ?? 0, output_tokens: usage.completion_tokens ?? 0, total_tokens: usage.total_tokens ?? 0 } : null, store: true };
}
export async function POST(request: Request) {
  const rid = request.headers.get("x-request-id") || `fr_${randomUUID()}`;
  let body: any; try { body = await readJson(request); } catch (e) { const m = e instanceof Error ? e.message : "Invalid JSON"; return jsonError(m === "body_too_large" ? 413 : m==="unsupported_content_type"||m==="unsupported_encoding"?415:400, m, "invalid_request", rid); }
  if (!body || typeof body !== "object" || typeof body.model !== "string") return jsonError(400,"model is required","invalid_request",rid);
  const auth = await authenticateClient(request,"responses",body.model); if ("error" in auth) return jsonError(auth.error === "invalid_api_key"?401:403,"API key cannot access this request",String(auth.error),rid);
  const accepted=new Set(["model","input","instructions","previous_response_id","stream","store","tools","tool_choice","max_output_tokens","reasoning","text","parallel_tool_calls","metadata","truncation","include"]);const unknown=Object.keys(body).find(k=>!accepted.has(k));if(unknown)return jsonError(400,`Unsupported Responses field: ${unknown}`,"unsupported_parameter",rid);
  if(body.include!==undefined&&(!Array.isArray(body.include)||body.include.length>0))return jsonError(400,"Requested include fields are not available for this provider profile","unsupported_parameter",rid);
  if(body.instructions!==undefined&&typeof body.instructions!=="string")return jsonError(400,"instructions must be a string","invalid_request",rid);
  if(body.metadata!==undefined&&(!body.metadata||typeof body.metadata!=="object"||Array.isArray(body.metadata)||Object.keys(body.metadata).length>16||Object.entries(body.metadata).some(([k,v])=>k.length>64||typeof v!=="string"||v.length>512)))return jsonError(400,"metadata must contain at most 16 short string entries","invalid_request",rid);
  const store = body.store !== false; let history: ChatMessage[] = [];
  try {
    if (body.previous_response_id) {
      if (typeof body.previous_response_id !== "string") throw new Error("Invalid previous_response_id");
      const db = await getDb(); const record = await db.collection<any>("responses").findOne({ responseId: body.previous_response_id, ownerId: String(auth.key._id), expiresAt: { $gt: new Date() } });
      if (!record) return jsonError(404,"Response is unavailable","response_not_found",rid);
      const data = decryptJson<{ messages: ChatMessage[] }>(record.payload, `${record.ownerId}:${record.responseId}:response:v1:${new Date(record.expiresAt).toISOString()}`); history = data.messages;
    }
    const fresh = convertInput(body.input ?? "");
    const messages: ChatMessage[] = [...history]; if (body.instructions) messages.push({ role: "developer", content: body.instructions }); messages.push(...fresh);
    const unsupported = ["conversation","background","truncation"].find(k => body[k] !== undefined && (k !== "truncation" || body[k] !== "disabled"));
    if (unsupported) return jsonError(400,`${unsupported} is unsupported in v1`,"unsupported_parameter",rid);
    if (body.tools?.some((t:any)=>t.type!=="function")) return jsonError(400,"Only caller-executed function tools are supported","unsupported_tool",rid);
    const toolChoice=body.tool_choice?.type==="function"?{type:"function",function:{name:body.tool_choice.name}}:body.tool_choice;
    const chatBody = { model: body.model, messages, stream: false, max_completion_tokens: body.max_output_tokens, tools: body.tools?.map((t:any)=>({type:"function",function:{name:t.name,description:t.description,parameters:t.parameters,strict:t.strict}})), tool_choice: toolChoice, parallel_tool_calls: body.parallel_tool_calls, response_format: body.text?.format ? body.text.format.type === "json_schema" ? {type:"json_schema",json_schema:{name:body.text.format.name,strict:body.text.format.strict,schema:body.text.format.schema}} : {type:body.text.format.type} : undefined, reasoning_effort: body.reasoning?.effort, store: false };
    const internal = new Request("https://freerouter.local/v1/chat/completions", { method:"POST", headers:{authorization:request.headers.get("authorization")||"", "content-type":"application/json", "x-request-id":rid}, body:JSON.stringify(chatBody) });
    const chat = await chatCompletions(internal); if (!chat.ok) return new Response(await chat.text(),{status:chat.status,headers:{"content-type":"application/json","cache-control":"no-store","x-request-id":rid}});
    const result = await chat.json() as any; const id = `resp_${randomUUID().replaceAll("-","")}`; const created = Math.floor(Date.now()/1000); const response = responseObject(id,body.model,result.choices?.[0]?.message,result.usage,created,body.input,body.metadata);
    if (store) { const expiresAt = new Date(Date.now()+86400000); const snapshot = [...messages, ...(result.choices?.[0]?.message ? [{role:"assistant",...result.choices[0].message}] : [])]; const payload=encryptJson({messages:snapshot,response},`${String(auth.key._id)}:${id}:response:v1:${expiresAt.toISOString()}`); await (await getDb()).collection("responses").insertOne({responseId:id,ownerId:String(auth.key._id),createdAt:new Date(),expiresAt,model:body.model,payload,expiresAtBytes:payload.body.length}); }
    response.store=store;
    if (body.stream === true) { const enc=new TextEncoder();const events:any[]=[];let seq=0;const add=(type:string,fields:any)=>events.push({type,sequence_number:seq++,...fields});const progress={...response,status:"in_progress",output:[],output_text:""};add("response.created",{response:progress});add("response.in_progress",{response:progress});for(let i=0;i<response.output.length;i++){const item=response.output[i];add("response.output_item.added",{output_index:i,item:{...item,status:"in_progress"}});if(item.type==="message"){add("response.content_part.added",{item_id:item.id,output_index:i,content_index:0,part:{type:"output_text",text:"",annotations:[]}});const text=item.content?.[0]?.text||"";if(text)add("response.output_text.delta",{item_id:item.id,output_index:i,content_index:0,delta:text});add("response.output_text.done",{item_id:item.id,output_index:i,content_index:0,text});add("response.content_part.done",{item_id:item.id,output_index:i,content_index:0,part:item.content[0]});}else{add("response.function_call_arguments.delta",{item_id:item.id,output_index:i,delta:item.arguments});add("response.function_call_arguments.done",{item_id:item.id,output_index:i,arguments:item.arguments});}add("response.output_item.done",{output_index:i,item});}add("response.completed",{response});const stream=new ReadableStream({start(c){for(const event of events)c.enqueue(enc.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));c.close()}});return new Response(stream,{headers:{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-store, no-transform","x-request-id":rid,"x-freerouter-resolved-model":chat.headers.get("x-freerouter-resolved-model")||body.model}}); }
    return Response.json(response,{headers:{"cache-control":"no-store","x-request-id":rid,"x-freerouter-resolved-model":chat.headers.get("x-freerouter-resolved-model")||body.model}});
  } catch(e) {const message=e instanceof Error?e.message:"Invalid request";if(message.includes("4 MiB")||message.includes("8 MiB"))return jsonError(413,message,"state_too_large",rid);if(message.includes("previous_response_id")||message.includes("Unsupported Responses input")||message.includes("Invalid input")||message.includes("input must"))return jsonError(400,message,"invalid_request",rid);return jsonError(503,"Responses state or persistence operation failed","response_state_unavailable",rid); }
}

export async function GET(request: Request, ctx: {params: Promise<Record<string,string>>}) {
  const auth=await authenticateClient(request,"responses");if("error" in auth)return jsonError(401,"Invalid API key","invalid_api_key");const id=new URL(request.url).pathname.split("/").filter(Boolean).at(-1)!;
  try {const rec=await(await getDb()).collection<any>("responses").findOne({responseId:id,ownerId:String(auth.key._id),expiresAt:{$gt:new Date()}});if(!rec)return jsonError(404,"Response is unavailable","response_not_found");const data=decryptJson<any>(rec.payload,`${rec.ownerId}:${rec.responseId}:response:v1:${new Date(rec.expiresAt).toISOString()}`);return Response.json(data.response,{headers:{"cache-control":"no-store"}});}catch{return jsonError(404,"Response is unavailable","response_not_found");}
}
