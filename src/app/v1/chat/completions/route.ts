import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { authenticateClient } from "@/lib/auth/client";
import { ALIASES, MODEL_BY_ID, type ModelProfile } from "@/lib/models/catalog";
import { getProviderCredentials } from "@/lib/env";
import { translateChatRequest, upstreamChat, type CanonicalChat } from "@/lib/providers/openai";
import { checkAdmission, releaseAdmission } from "@/lib/redis";
import { getRedis, useDailyBudgets } from "@/lib/redis";
import { callSystemOne } from "@/lib/jev";
import { hashClientKey } from "@/lib/crypto";
import { normalizeChatEvent,parseSseData } from "@/lib/providers/sse";
import Ajv from "ajv";
import { jsonError, readJson } from "@/lib/http";
export const runtime = "nodejs";
export const maxDuration = 300;
const ajv=new Ajv({allErrors:true,strict:false,allowUnionTypes:true});
function resolveCandidates(id: string, category="code"): ModelProfile[] { const alias=id==="fr-auto"?`fr-${category}`:id;const ids = ALIASES[alias] || [id]; return ids.map(x => MODEL_BY_ID.get(x)).filter((x): x is ModelProfile => Boolean(x && x.status === "ready" && x.text === "passed")); }
async function classifyAuto(body:CanonicalChat,keyId:string,allowed:boolean) {
  const fallback=body.messages.some((m:any)=>Array.isArray(m?.content)&&m.content.some((p:any)=>p?.type==="image_url"))?"vision":body.reasoning_effort==="high"?"quality":body.reasoning_effort==="low"||body.reasoning_effort==="minimal"?"fast":"code";
  if(!allowed)return fallback;
  try { const db=await getDb();const settings=await db.collection("settings").findOne({_id:"jev-routing" as any});if(settings?.enabled!==true||settings?.acknowledged!==true)return fallback;
    const text=body.messages.filter((m:any)=>m.role==="user").map((m:any)=>typeof m.content==="string"?m.content:Array.isArray(m.content)?m.content.filter((p:any)=>p.type==="text").map((p:any)=>p.text).join(" "):"").join("\n").slice(-8192);
    const requirements={tools:Boolean(body.tools?.length),strictSchema:(body.response_format as any)?.type==="json_schema",vision:fallback==="vision",reasoning:body.reasoning_effort||"medium"};const hash=hashClientKey(`${keyId}:${text}:${JSON.stringify(requirements)}:classify-v1`);const redis=getRedis();const cached=await redis.get<string>(`fr:v1:jev:cache:${hash}`);if(cached&&["fast","code","quality","vision"].includes(cached))return cached;
    if(!await useDailyBudgets([{id:`jev-total:${keyId}`,limit:100},{id:`classifier:${keyId}`,limit:25}]))return fallback;
    const response=await callSystemOne({model:"jev-latest",state:{excerpt:text,requirements},questions:{category:{type:"choice",instructions:"Choose the best model category for this coding assistant request.",criteria:{fast:"Short, simple, low latency task",code:"General software engineering or coding task",quality:"Complex reasoning or high quality task",vision:"Task requires understanding provided images"}}}},undefined,1000);
    if(!response.ok)return fallback;const data=await response.json() as any;const answer=data.answers?.category;const category=answer?.choice;if(Number(answer?.confidence??0)<.85||!["fast","code","quality","vision"].includes(category))return fallback;await redis.set(`fr:v1:jev:cache:${hash}`,category,{ex:900});return category;
  }catch{return fallback;}
}
function supportsRequest(profile: ModelProfile, body: CanonicalChat) {
  if (body.tools && body.tools.length && profile.tools !== "passed") return false;
  if (body.tools?.some((t:any)=>t?.function?.strict===true) && profile.schema !== "passed") return false;
  if (body.response_format && (body.response_format as any).type === "json_schema" && profile.schema !== "passed") return false;
  if (body.response_format && (body.response_format as any).type === "json_object" && profile.schema === "failed") return false;
  const hasImage = body.messages.some((m: any) => Array.isArray(m?.content) && m.content.some((p: any) => p?.type === "image_url"));
  if (hasImage && profile.vision !== "passed") return false;
  const effort = body.reasoning_effort;
  if (effort && effort !== "medium" && !["nvidia/z-ai/glm-5.3-flash","nvidia/deepseek-ai/deepseek-v4.1-flash","google/gemini-3.6-flash"].includes(profile.id)) return false;
  return true;
}
function validateGenerated(input:CanonicalChat,content:string,toolCalls:any[]){
  const format=input.response_format as any;
  if(format?.type==="json_object"){try{JSON.parse(content)}catch{return "invalid_json_output"}}
  if(format?.type==="json_schema"&&format.json_schema?.strict===true){try{const valid=ajv.compile(format.json_schema.schema);if(!valid(JSON.parse(content)))return "json_schema_validation_failed"}catch{return "json_schema_validation_failed"}}
  for(const call of toolCalls){let args:any;try{args=JSON.parse(call.function.arguments)}catch{return "invalid_tool_arguments"}const declaration=(input.tools as any[]|undefined)?.find(t=>t?.function?.name===call.function.name);if(!declaration)return "unknown_tool_call";if(declaration.function.strict===true){try{const valid=ajv.compile(declaration.function.parameters);if(!valid(args))return "tool_schema_validation_failed"}catch{return "tool_schema_validation_failed"}}}
  return null;
}
function decodeSseEvent(text: string) { const data = parseSseData(text).join("\n"); if (!data || data === "[DONE]") return null; try { return JSON.parse(data); } catch { return null; } }
function retryAt(response:Response){const value=response.headers.get("retry-after");if(!value)return new Date(Date.now()+30000);const seconds=Number(value);const date=Number.isFinite(seconds)?Date.now()+seconds*1000:Date.parse(value);return new Date(Math.min(Date.now()+86400000,Number.isFinite(date)?date:Date.now()+30000))}
async function upstreamErrorCode(response:Response){try{const body=await response.clone().json() as any;const code=body?.error?.code??body?.error?.status??body?.code;return typeof code==="string"||typeof code==="number"?String(code).replace(/[^A-Za-z0-9_.-]/g,"").slice(0,80):""}catch{return ""}}
export async function POST(request: Request) {
  const rid = request.headers.get("x-request-id") || `fr_${randomUUID()}`;
  let input: CanonicalChat;
  try { input = translateChatRequest(await readJson(request)); } catch (e) { const m = e instanceof Error ? e.message : "Invalid request"; return jsonError(m === "body_too_large" ? 413 : m === "unsupported_content_type"||m==="unsupported_encoding" ? 415 : 400, m, "invalid_request", rid); }
  const auth = await authenticateClient(request, "chat", input.model);
  if ("error" in auth) return jsonError(auth.error === "invalid_api_key" ? 401 : 403, auth.error === "invalid_api_key" ? "Invalid API key" : "API key cannot access this request", String(auth.error), rid);
  const alias = input.model.startsWith("fr-"); const category=input.model==="fr-auto"?await classifyAuto(input,String(auth.key._id),auth.key.allowJevRouting!==false):"code"; const declared = resolveCandidates(input.model,category); const candidates = declared.filter(p => supportsRequest(p,input));
  if (!candidates.length) return declared.length ? jsonError(400, "The selected model does not support one or more requested capabilities", "unsupported_capability", rid) : jsonError(404, "Unknown or unavailable model", "model_not_found", rid);
  const failures: string[] = [];let dispatched=0;
  const db = await getDb();
  for (const profile of candidates.slice(0, 3)) {
    const credentials = getProviderCredentials().filter(c => c.provider === profile.provider);
    if (!credentials.length) continue;
    const ranked=await Promise.all(credentials.map(async c=>{const [h,b]=await Promise.all([db.collection<any>("credential_health").findOne({provider:profile.provider,fingerprint:c.fingerprint}),db.collection<any>("model_bindings").findOne({provider:profile.provider,model:profile.upstream,fingerprint:c.fingerprint})]);return{c,rank:b?.status==="healthy"?0:h?.authStatus==="healthy"?1:2,b}}));
    const ordered=[0,1,2].flatMap(rank=>{const group=ranked.filter(x=>x.rank===rank).map(x=>x.c);if(!group.length)return[];const start=(Date.now()+profile.id.length+rank)%group.length;return [...group.slice(start),...group.slice(0,start)]});
    for (const credential of ordered) {
      if(dispatched>=3)break;
      const lease = `${rid}:${profile.id}:${credential.slot}`;
      const scopes=[`global`, `client:${auth.key._id}`, `provider:${profile.provider}:account:${credential.slot}`, `binding:${profile.id}:${credential.slot}`];
      let admitted = false;
      try {
        const health=await db.collection<any>("credential_health").findOne({provider:profile.provider,fingerprint:credential.fingerprint});if(health&&(health.paused===true||health.authStatus==="invalid"||(health.cooldownUntil&&new Date(health.cooldownUntil)>new Date())))continue;
        const binding=await db.collection<any>("model_bindings").findOne({provider:profile.provider,model:profile.upstream,fingerprint:credential.fingerprint});if(binding?.status==="unavailable"||(binding?.cooldownUntil&&new Date(binding.cooldownUntil)>new Date())||((input.response_format as any)?.type==="json_schema"&&binding?.schemaStatus==="failed")||(input.tools as any[]|undefined)?.some(t=>t.function?.strict===true&&binding?.schemaStatus==="failed"))continue;
        const admission = await checkAdmission(scopes, lease);
        if (!admission.allowed) continue; admitted = true;
        const body = { ...input, model: profile.upstream, stream: true };
        dispatched++;
        const upstream = await upstreamChat(profile, credential, body, request.signal);
        if (!upstream.ok || !upstream.body) { const code=await upstreamErrorCode(upstream);failures.push(`${upstream.status}${code?`:${code}`:""}`);await releaseAdmission(scopes,lease);if(upstream.status===401)await db.collection("credential_health").updateOne({provider:profile.provider,fingerprint:credential.fingerprint},{$set:{authStatus:"invalid",checkedAt:new Date()}},{upsert:true});else if(upstream.status===400||upstream.status===404||upstream.status===410)await db.collection("model_bindings").updateOne({provider:profile.provider,model:profile.upstream,fingerprint:credential.fingerprint},{$set:{status:"unavailable",reason:`upstream_${upstream.status}`,checkedAt:new Date()}},{upsert:true});else if(upstream.status===429)await db.collection("model_bindings").updateOne({provider:profile.provider,model:profile.upstream,fingerprint:credential.fingerprint},{$set:{cooldownUntil:retryAt(upstream),reason:"upstream_rate_limit",checkedAt:new Date()}},{upsert:true});else if(upstream.status>=500)await db.collection("model_bindings").updateOne({provider:profile.provider,model:profile.upstream,fingerprint:credential.fingerprint},{$set:{cooldownUntil:new Date(Date.now()+30000),reason:"upstream_server_error",checkedAt:new Date()}},{upsert:true});continue; }
        await db.collection("credential_health").updateOne({provider:profile.provider,fingerprint:credential.fingerprint},{$set:{authStatus:"healthy",lastSuccessAt:new Date(),lastSuccessModel:profile.upstream}},{upsert:true});await db.collection("model_bindings").updateOne({provider:profile.provider,model:profile.upstream,fingerprint:credential.fingerprint},{$set:{status:"healthy",lastSuccessAt:new Date()},$unset:{cooldownUntil:"",reason:""}},{upsert:true});
        const record = { requestId: rid, keyId: String(auth.key._id), requestedModel: input.model, model: profile.id, provider: profile.provider, credentialSlot: credential.slot, status: "streaming", createdAt: new Date(), expiresAt:new Date(Date.now()+7*86400000), alias };
        void db.collection("requests").insertOne(record).catch(() => undefined);
        const wantStream = input.stream === true;
        const validateBeforeRelease=Boolean((input.response_format as any)?.type==="json_object"||(input.response_format as any)?.type==="json_schema"&&(input.response_format as any)?.json_schema?.strict===true||(input.tools as any[]|undefined)?.some(t=>t.function?.strict===true));
        if (wantStream&&!validateBeforeRelease) {
          const headers = new Headers({ "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store, no-transform", connection: "keep-alive", "x-request-id": rid, "x-freerouter-resolved-model": profile.id });
          const reader = upstream.body.getReader();
          const streamState={toolIndex:new Map<string,number>(),toolCallId:new Map<string,string>(),toolIds:new Map<number,Set<string>>(),finished:new Set<number>()};
          const stream = new ReadableStream<Uint8Array>({ start(controller) { const encoder=new TextEncoder(),decoder=new TextDecoder();let buffer="",doneSent=false,closed=false;controller.enqueue(encoder.encode(": freerouter connected\n\n"));const heartbeat=setInterval(()=>{if(!closed)controller.enqueue(encoder.encode(": freerouter keepalive\n\n"))},10000);
            const emit=(raw:string)=>{if(raw.trimStart().startsWith(":")){controller.enqueue(encoder.encode(`${raw}\n\n`));return}const data=parseSseData(raw).join("\n");if(!data)return;if(data==="[DONE]"){if(!doneSent){doneSent=true;controller.enqueue(encoder.encode("data: [DONE]\n\n"))}return}let event:any;try{event=JSON.parse(data)}catch{controller.enqueue(encoder.encode(`data: ${JSON.stringify({error:{message:"Malformed upstream stream event",type:"server_error",code:"upstream_protocol_error"}})}\n\n`));return}const normalized=normalizeChatEvent(event,profile.id,streamState,input.stream_options?.include_usage===true);if(normalized)controller.enqueue(encoder.encode(`data: ${JSON.stringify(normalized)}\n\n`))};
            void (async()=>{try{while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});const parts=buffer.split(/\r?\n\r?\n/);buffer=parts.pop()||"";for(const part of parts)emit(part)}buffer+=decoder.decode();if(buffer.trim())emit(buffer);if(!doneSent)controller.enqueue(encoder.encode(`data: ${JSON.stringify({error:{message:"Upstream stream ended before completion",type:"server_error",code:"incomplete_upstream_stream"}})}\n\n`));await db?.collection("requests").updateOne({requestId:rid},{$set:{status:doneSent?"completed":"failed",completedAt:new Date()}});closed=true;clearInterval(heartbeat);controller.close()}catch{closed=true;clearInterval(heartbeat);try{controller.enqueue(encoder.encode(`data: ${JSON.stringify({error:{message:"Upstream stream failed",type:"server_error",code:"upstream_stream_error"}})}\n\n`));controller.close()}catch{}await db?.collection("requests").updateOne({requestId:rid},{$set:{status:"failed",completedAt:new Date()}})}finally{await releaseAdmission(scopes,lease)}})();
          },cancel(reason){void reader.cancel(reason);void releaseAdmission(scopes,lease)}});
          return new Response(stream, { headers });
        }
        const reader = upstream.body.getReader(); const decoder = new TextDecoder(); let buffer = ""; const events: unknown[] = [];
        while (true) { const { done, value } = await reader.read(); if (done) break; buffer += decoder.decode(value, { stream: true }); const chunks = buffer.split(/\r?\n\r?\n/); buffer = chunks.pop() || ""; for (const chunk of chunks) { const event = decodeSseEvent(chunk); if (event) events.push(event); } }
        buffer+=decoder.decode();if(buffer.trim()){const event=decodeSseEvent(buffer);if(event)events.push(event)}
        const streamState={toolIndex:new Map<string,number>(),toolCallId:new Map<string,string>(),toolIds:new Map<number,Set<string>>(),finished:new Set<number>()};const normalized=events.map(e=>normalizeChatEvent(e,profile.id,streamState,true)).filter(Boolean);
        const first = normalized[0] as Record<string, unknown> | undefined; const last = normalized.at(-1) as Record<string, unknown> | undefined;
        const content = normalized.map(e => (e as any)?.choices?.[0]?.delta?.content || "").join("");
        const toolCalls = new Map<number, any>();
        for (const event of normalized as any[]) for (const call of event.choices?.[0]?.delta?.tool_calls || []) { const prior = toolCalls.get(call.index) || { id: call.id, type: "function", function: { name: "", arguments: "" } }; if (call.id) prior.id = call.id; if (call.function?.name) prior.function.name += call.function.name; if (call.function?.arguments) prior.function.arguments += call.function.arguments; toolCalls.set(call.index, prior); }
        await releaseAdmission(scopes, lease); await db?.collection("requests").updateOne({ requestId: rid }, { $set: { status: "completed", completedAt: new Date() } });
        const finish=(normalized as any[]).map(e=>e?.choices?.[0]?.finish_reason).filter(Boolean).at(-1);const usage=(normalized as any[]).map(e=>e?.usage).filter(Boolean).at(-1);const toolList=[...toolCalls.values()];const invalid=validateGenerated(input,content,toolList);
        if(invalid){failures.push(invalid);await db.collection("model_bindings").updateOne({provider:profile.provider,model:profile.upstream,fingerprint:credential.fingerprint},{$set:{schemaStatus:"failed",schemaFailure:invalid,checkedAt:new Date()}},{upsert:true});continue;}
        if((input.response_format as any)?.type==="json_schema"||(input.tools as any[]|undefined)?.some(t=>t.function?.strict===true))await db.collection("model_bindings").updateOne({provider:profile.provider,model:profile.upstream,fingerprint:credential.fingerprint},{$set:{schemaStatus:"passed",schemaCheckedAt:new Date()},$unset:{schemaFailure:""}},{upsert:true});
        const choices = [{ index: 0, message: { role: "assistant", content: content || null, ...(toolCalls.size ? { tool_calls: [...toolCalls.values()] } : {}) }, finish_reason: finish || (toolCalls.size ? "tool_calls" : "stop") }];
        if(wantStream){const enc=new TextEncoder(),id=(first as any)?.id||`chatcmpl-${rid}`,created=(first as any)?.created||Math.floor(Date.now()/1000),chunks:any[]=[{id,object:"chat.completion.chunk",created,model:profile.id,choices:[{index:0,delta:{role:"assistant"},finish_reason:null}]},{id,object:"chat.completion.chunk",created,model:profile.id,choices:[{index:0,delta:{content},finish_reason:null}]},{id,object:"chat.completion.chunk",created,model:profile.id,choices:[{index:0,delta:{},finish_reason:finish||"stop"}]}];if(input.stream_options?.include_usage&&usage)chunks.push({id,object:"chat.completion.chunk",created,model:profile.id,choices:[],usage});const stream=new ReadableStream({start(c){for(const chunk of chunks)c.enqueue(enc.encode(`data: ${JSON.stringify(chunk)}\n\n`));c.enqueue(enc.encode("data: [DONE]\n\n"));c.close()}});return new Response(stream,{headers:{"content-type":"text/event-stream; charset=utf-8","cache-control":"no-store, no-transform","x-request-id":rid,"x-freerouter-resolved-model":profile.id}})}
        return Response.json({ id: (first as any)?.id || `chatcmpl-${rid}`, object: "chat.completion", created: (first as any)?.created || Math.floor(Date.now()/1000), model: input.model, choices, ...(usage?{usage}:{}) }, { headers: { "cache-control": "no-store", "x-request-id": rid, "x-freerouter-resolved-model": profile.id } });
      } catch (e) { if (admitted) await releaseAdmission(scopes, lease).catch(() => undefined); failures.push(e instanceof Error ? e.name : "error"); }
    }
    if (!alias||dispatched>=3) break;
  }
  void db.collection("requests").insertOne({requestId:rid,keyId:String(auth.key._id),requestedModel:input.model,status:"failed",failureStatuses:failures,dispatchedAttempts:dispatched,createdAt:new Date(),expiresAt:new Date(Date.now()+7*86400000)}).catch(()=>undefined);
  const upstreamLimited=failures.length>0&&failures.every(x=>x.startsWith("429"));const badRequest=failures.length>0&&failures.every(x=>x.startsWith("400"));const invalidOutput=failures.some(x=>/^(invalid_|unknown_tool|.*schema_validation)/.test(x));return jsonError(upstreamLimited?429:badRequest?400:invalidOutput?502:failures.length||dispatched?503:429, upstreamLimited?"Upstream quota is temporarily exhausted":badRequest?"The upstream rejected this request":invalidOutput?"The upstream did not satisfy the requested output contract":"No eligible upstream model is currently available", upstreamLimited?"rate_limit_exceeded":badRequest?"upstream_request_rejected":invalidOutput?"upstream_invalid_output":failures.length||dispatched?"upstream_unavailable":"rate_limit_exceeded", rid);
}
