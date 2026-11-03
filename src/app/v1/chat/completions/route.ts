import { randomUUID } from "node:crypto";
import { getDb } from "@/lib/db";
import { authenticateClient, consumeInternalClient } from "@/lib/auth/client";
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
import { clearModelOverload, isPersistedModelCoolingDown, recordModelOverload } from "@/lib/models/overload-breaker";
import { applyVerdict, classifyUpstream, summarizeFailures, type UpstreamVerdict } from "@/lib/failures";
import { RequestValidationError } from "@/lib/validation";
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
function supportsReasoningEffort(profile:ModelProfile){return ["nvidia/z-ai/glm-5.3-flash","nvidia/deepseek-ai/deepseek-v4.1-flash","google/gemini-3.6-flash"].includes(profile.id);}
function supportsRequest(profile: ModelProfile, body: CanonicalChat) {
  if (body.tools && body.tools.length && profile.tools !== "passed") return false;
  if (body.tools?.some((t:any)=>t?.function?.strict===true) && profile.schema !== "passed") return false;
  if (body.response_format && (body.response_format as any).type === "json_schema" && profile.schema !== "passed") return false;
  if (body.response_format && (body.response_format as any).type === "json_object" && profile.schema === "failed") return false;
  const hasImage = body.messages.some((m: any) => Array.isArray(m?.content) && m.content.some((p: any) => p?.type === "image_url"));
  if (hasImage && profile.vision !== "passed") return false;
  const effort = body.reasoning_effort;
  const fastAliasHint=body.model.startsWith("fr-")&&(effort==="low"||effort==="minimal")&&profile.latency==="fast";
  if (effort && effort !== "medium" && !supportsReasoningEffort(profile) && !fastAliasHint) return false;
  return true;
}
function providerRequestBody(profile:ModelProfile,input:CanonicalChat,alias:boolean){const body:any={...input,model:profile.upstream,stream:true};const fastAliasHint=alias&&(input.reasoning_effort==="low"||input.reasoning_effort==="minimal")&&profile.latency==="fast";if(fastAliasHint&&!supportsReasoningEffort(profile))delete body.reasoning_effort;return body;}
function validateGenerated(input:CanonicalChat,content:string,toolCalls:any[]){
  const format=input.response_format as any;
  if(format?.type==="json_object"){try{JSON.parse(content)}catch{return "invalid_json_output"}}
  if(format?.type==="json_schema"&&format.json_schema?.strict===true){try{const valid=ajv.compile(format.json_schema.schema);if(!valid(JSON.parse(content)))return "json_schema_validation_failed"}catch{return "json_schema_validation_failed"}}
  for(const call of toolCalls){let args:any;try{args=JSON.parse(call.function.arguments)}catch{return "invalid_tool_arguments"}const declaration=(input.tools as any[]|undefined)?.find(t=>t?.function?.name===call.function.name);if(!declaration)return "unknown_tool_call";if(declaration.function.strict===true){try{const valid=ajv.compile(declaration.function.parameters);if(!valid(args))return "tool_schema_validation_failed"}catch{return "tool_schema_validation_failed"}}}
  return null;
}
function decodeSseEvent(text: string) { const data = parseSseData(text).join("\n"); if (!data || data === "[DONE]") return null; try { return JSON.parse(data); } catch { return null; } }
async function upstreamErrorCode(response:Response){try{const body=await response.clone().json() as any;const code=body?.error?.code??body?.error?.status??body?.code;return typeof code==="string"||typeof code==="number"?String(code).replace(/[^A-Za-z0-9_.-]/g,"").slice(0,80):""}catch{return ""}}
function verdictFor(status:number|null,reason:string):UpstreamVerdict{return {status,action:"continue",reason};}

function streamChatResponse(args:{request:Request;rid:string;input:CanonicalChat;keyId:string;candidates:ModelProfile[];alias:boolean;db:Awaited<ReturnType<typeof getDb>>}) {
  const {request,rid,input,keyId,candidates,alias,db}=args;
  const encoder=new TextEncoder();
  const strict=Boolean((input.response_format as any)?.type==="json_object"||(input.response_format as any)?.type==="json_schema"&&(input.response_format as any)?.json_schema?.strict===true||(input.tools as any[]|undefined)?.some(t=>t.function?.strict===true));
  const aborter=new AbortController();
  let activeReader:ReadableStreamDefaultReader<Uint8Array>|undefined;
  let activeScopes:string[]|undefined;
  let activeLease:string|undefined;
  let heartbeat:ReturnType<typeof setInterval>|undefined;
  let deadline:ReturnType<typeof setTimeout>|undefined;
  let cancelled=false;
  const onRequestAbort=()=>aborter.abort(request.signal.reason);
  request.signal.addEventListener("abort",onRequestAbort,{once:true});
  if(request.signal.aborted)onRequestAbort();
  const headers=new Headers({"content-type":"text/event-stream; charset=utf-8","cache-control":"no-store, no-transform",connection:"keep-alive","x-request-id":rid});
  if(!alias)headers.set("x-freerouter-resolved-model",candidates[0].id);
  const stream=new ReadableStream<Uint8Array>({
    start(controller){
      let closed=false;
      const write=(value:string)=>{if(!closed&&!cancelled)controller.enqueue(encoder.encode(value))};
      const close=()=>{if(closed||cancelled)return;closed=true;if(heartbeat)clearInterval(heartbeat);if(deadline)clearTimeout(deadline);request.signal.removeEventListener("abort",onRequestAbort);controller.close()};
      const failFrame=(message:string,code:string)=>write(`data: ${JSON.stringify({error:{message,type:"server_error",code,request_id:rid}})}\n\n`);
      write(": freerouter connected\n\n");
      heartbeat=setInterval(()=>write(": freerouter keepalive\n\n"),10000);
      deadline=setTimeout(()=>aborter.abort(new Error("gateway_deadline")),275000);
      void (async()=>{
        const failures:UpstreamVerdict[]=[];let dispatched=0;let semanticDelivered=false;let finalStatus="pending";
        try {
          await db.collection("requests").updateOne({requestId:rid},{$setOnInsert:{requestId:rid,keyId,requestedModel:input.model,status:"admitted",createdAt:new Date(),expiresAt:new Date(Date.now()+7*86400000),alias}}, {upsert:true});
          for(const profile of candidates.slice(0,3)){
            if(await isPersistedModelCoolingDown(db,profile.provider,profile.upstream)){failures.push(verdictFor(503,"503:model_overload_cooldown"));continue;}
            const credentials=getProviderCredentials().filter(c=>c.provider===profile.provider);
            if(!credentials.length)continue;
            const ranked=await Promise.all(credentials.map(async c=>{const [h,b]=await Promise.all([db.collection<any>("credential_health").findOne({provider:profile.provider,fingerprint:c.fingerprint}),db.collection<any>("model_bindings").findOne({provider:profile.provider,model:profile.upstream,fingerprint:c.fingerprint})]);return{c,rank:b?.status==="healthy"?0:h?.authStatus==="healthy"?1:2};}));
            const ordered=[0,1,2].flatMap(rank=>{const group=ranked.filter(x=>x.rank===rank).map(x=>x.c);if(!group.length)return[];const start=(Date.now()+profile.id.length+rank)%group.length;return [...group.slice(start),...group.slice(0,start)]});
            for(const credential of ordered){
              if(dispatched>=3||aborter.signal.aborted)break;
              if(await isPersistedModelCoolingDown(db,profile.provider,profile.upstream)){failures.push(verdictFor(503,"503:model_overload_cooldown"));break;}
              const lease=`${rid}:${profile.id}:${credential.slot}`;
              const scopes=["global",`client:${keyId}`,`provider:${profile.provider}:account:${credential.slot}`,`binding:${profile.id}:${credential.slot}`];
              try{
                const health=await db.collection<any>("credential_health").findOne({provider:profile.provider,fingerprint:credential.fingerprint});
                if(health&&(health.paused===true||health.authStatus==="invalid"||(health.cooldownUntil&&new Date(health.cooldownUntil)>new Date())))continue;
                const binding=await db.collection<any>("model_bindings").findOne({provider:profile.provider,model:profile.upstream,fingerprint:credential.fingerprint});
                if(binding?.status==="unavailable"||(binding?.cooldownUntil&&new Date(binding.cooldownUntil)>new Date())||((input.response_format as any)?.type==="json_schema"&&binding?.schemaStatus==="failed")||(input.tools as any[]|undefined)?.some(t=>t.function?.strict===true&&binding?.schemaStatus==="failed"))continue;
                const admission=await checkAdmission(scopes,lease);
                if(!admission.allowed){failures.push(verdictFor(429,"429:admission_denied"));continue;}
                activeScopes=scopes;activeLease=lease;dispatched++;
                const attemptIndex=dispatched-1;
                await db.collection<any>("requests").updateOne({requestId:rid},{$push:{attempts:{model:profile.id,provider:profile.provider,credentialSlot:credential.slot,status:"dispatched",startedAt:new Date()}},$set:{status:"connecting",model:profile.id,provider:profile.provider,credentialSlot:credential.slot}} as any);
                const body=providerRequestBody(profile,input,alias);
                const requestStartedAt=new Date();
                const upstream=await upstreamChat(profile,credential,body,aborter.signal);
                if(!upstream.ok||!upstream.body){
                  const verdict=classifyUpstream({status:upstream.status,providerCode:await upstreamErrorCode(upstream),retryAfter:upstream.headers.get("retry-after")});
                  failures.push(verdict);
                  await db.collection("requests").updateOne({requestId:rid},{$set:{[`attempts.${attemptIndex}.status`]:"failed",[`attempts.${attemptIndex}.failure`]:verdict.reason}});
                  await releaseAdmission(scopes,lease);activeScopes=undefined;activeLease=undefined;
                  await applyVerdict(db,verdict,{provider:profile.provider,model:profile.upstream,fingerprint:credential.fingerprint});
                  if(verdict.overload)await recordModelOverload(db,profile.provider,profile.upstream);
                  if(verdict.action!=="continue")break;
                  continue;
                }
                await db.collection("credential_health").updateOne({provider:profile.provider,fingerprint:credential.fingerprint},{$set:{authStatus:"healthy",lastSuccessAt:new Date(),lastSuccessModel:profile.upstream}},{upsert:true});
                await db.collection("model_bindings").updateOne({provider:profile.provider,model:profile.upstream,fingerprint:credential.fingerprint},{$set:{status:"healthy",lastSuccessAt:new Date()},$unset:{cooldownUntil:"",reason:""}},{upsert:true});
                await clearModelOverload(db,profile.provider,profile.upstream,requestStartedAt);
                await db.collection("requests").updateOne({requestId:rid},{$set:{status:"streaming",[`attempts.${attemptIndex}.status`]:"streaming",[`attempts.${attemptIndex}.headersAt`]:new Date()}});
                activeReader=upstream.body.getReader();
                const decoder=new TextDecoder();let buffer="",doneSent=false,semantic=false,roleSent=false,bufferedBytes=0,sawToolCall=false;
                const toolIndex=new Map<string,number>(),toolCallId=new Map<string,string>(),toolIds=new Map<number,Set<string>>(),finished=new Set<number>();
                const protocolState={toolIndex,toolCallId,toolIds,finished};
                const buffered:any[]=[];
                let content="";const toolCalls=new Map<number,any>();let terminalFinish:string|undefined;
                const parseEvent=(raw:string):boolean=>{
                  if(raw.trimStart().startsWith(":"))return false;
                  const data=parseSseData(raw).join("\n");if(!data)return false;
                  if(data==="[DONE]"){doneSent=true;return true;}
                  let event:any;try{event=JSON.parse(data)}catch{throw new Error("upstream_protocol_error")}
                  const normalized=normalizeChatEvent(event,profile.id,protocolState,input.stream_options?.include_usage===true) as any;
                  if(!normalized)return false;
                  const visibleChoices=[];
                  for(const choice of normalized.choices||[]){
                    const delta=choice.delta||{};delete delta.reasoning_content;delete delta.reasoning;
                    if(strict&&typeof delta.content==="string")content+=delta.content;
                    for(const call of delta.tool_calls||[]){sawToolCall=true;if(strict){const prior=toolCalls.get(call.index)||{id:call.id,type:"function",function:{name:"",arguments:""}};if(call.id)prior.id=call.id;if(call.function?.name)prior.function.name+=call.function.name;if(call.function?.arguments)prior.function.arguments+=call.function.arguments;toolCalls.set(call.index,prior);}}
                    if(choice.finish_reason)terminalFinish=choice.finish_reason;
                    if(Object.keys(delta).length||choice.finish_reason)visibleChoices.push({...choice,delta});
                  }
                  const cleaned={...normalized,...(Array.isArray(normalized.choices)?{choices:visibleChoices}:{})};
                  const meaningful=visibleChoices.some((c:any)=>{const d=c.delta||{};return (typeof d.content==="string"&&d.content.length>0)||(d.tool_calls?.length>0)||typeof d.refusal==="string";});
                  if(meaningful)semantic=true;
                  if(strict){
                    if(semantic||visibleChoices.length||cleaned.usage){const eventSize=encoder.encode(JSON.stringify(cleaned)).byteLength;bufferedBytes+=eventSize;if(bufferedBytes>8*1024*1024)throw new Error("structured_output_too_large");buffered.push(cleaned);}
                  }else if(semantic){
                    if(!roleSent){write(`data: ${JSON.stringify({id:cleaned.id||`chatcmpl-${rid}`,object:"chat.completion.chunk",created:cleaned.created||Math.floor(Date.now()/1000),model:profile.id,choices:[{index:0,delta:{role:"assistant"},finish_reason:null}]})}\n\n`);roleSent=true;}
                    if(visibleChoices.length||cleaned.usage)write(`data: ${JSON.stringify(cleaned)}\n\n`);
                    semanticDelivered=true;
                  }
                  return false;
                };
                while(!doneSent){
                  const {done,value}=await activeReader.read();if(done)break;
                  buffer+=decoder.decode(value,{stream:true});if(buffer.length>4*1024*1024)throw new Error("upstream_event_too_large");const parts=buffer.split(/\r?\n\r?\n/);buffer=parts.pop()||"";
                  for(const part of parts)parseEvent(part);
                  if(doneSent)break;
                }
                buffer+=decoder.decode();if(buffer.trim())parseEvent(buffer);
                const assembledTools=[...toolCalls.values()];
                const invalid=strict?validateGenerated(input,content,assembledTools):null;
                if(invalid){
                  failures.push(verdictFor(200,invalid));await db.collection("model_bindings").updateOne({provider:profile.provider,model:profile.upstream,fingerprint:credential.fingerprint},{$set:{schemaStatus:"failed",schemaFailure:invalid,checkedAt:new Date()}},{upsert:true});
                  await db.collection("requests").updateOne({requestId:rid},{$set:{[`attempts.${attemptIndex}.status`]:"invalid_output",[`attempts.${attemptIndex}.failure`]:invalid}});
                  await releaseAdmission(scopes,lease);activeScopes=undefined;activeLease=undefined;continue;
                }
                if(!doneSent||!semantic){
                  const reason=!doneSent?"incomplete_upstream_stream":"empty_upstream_output";failures.push(verdictFor(null,reason));
                  await db.collection("requests").updateOne({requestId:rid},{$set:{[`attempts.${attemptIndex}.status`]:"failed",[`attempts.${attemptIndex}.failure`]:reason}});
                  await releaseAdmission(scopes,lease);activeScopes=undefined;activeLease=undefined;
                  if(semanticDelivered){failFrame("Upstream stream ended before completion","incomplete_upstream_stream");finalStatus="failed";break;}
                  continue;
                }
                if(strict){for(const event of buffered)write(`data: ${JSON.stringify(event)}\n\n`);semanticDelivered=true;}
                if(!terminalFinish&&semanticDelivered)write(`data: ${JSON.stringify({id:`chatcmpl-${rid}`,object:"chat.completion.chunk",created:Math.floor(Date.now()/1000),model:profile.id,choices:[{index:0,delta:{},finish_reason:sawToolCall?"tool_calls":"stop"}]})}\n\n`);
                write("data: [DONE]\n\n");
                await db.collection("requests").updateOne({requestId:rid},{$set:{status:"completed",resolvedModel:profile.id,completedAt:new Date(),[`attempts.${attemptIndex}.status`]:"completed"}});
                finalStatus="completed";break;
              }catch(error){
                if(activeScopes&&activeLease){await releaseAdmission(activeScopes,activeLease).catch(()=>undefined);activeScopes=undefined;activeLease=undefined;}
                if(aborter.signal.aborted){failures.push(verdictFor(null,"aborted"));break;}
                const reason=error instanceof Error?error.message:"upstream_error";failures.push(verdictFor(null,reason));
                if(semanticDelivered){failFrame("Upstream stream failed",reason==="upstream_protocol_error"?reason:"upstream_stream_error");finalStatus="failed";break;}
                await db.collection("requests").updateOne({requestId:rid},{$set:{status:"retrying",[`attempts.${dispatched-1}.status`]:"failed",[`attempts.${dispatched-1}.failure`]:reason}}).catch(()=>undefined);
              }finally{
                if(activeReader){await activeReader.cancel().catch(()=>undefined);activeReader=undefined;}
                if(activeScopes&&activeLease){await releaseAdmission(activeScopes,activeLease).catch(()=>undefined);activeScopes=undefined;activeLease=undefined;}
              }
              if(!alias)break;
            }
            if(!alias||dispatched>=3||semanticDelivered)break;
          }
          if(finalStatus!=="completed"&&finalStatus!=="failed"){
            const summary=summarizeFailures(failures,dispatched);
            failFrame(summary.status===429?"Upstream quota is temporarily exhausted":"No eligible upstream produced a complete response",summary.code);
          }
          await db.collection("requests").updateOne({requestId:rid},{$set:{status:finalStatus,completedAt:new Date(),failureStatuses:failures.map(f=>f.reason),dispatchedAttempts:dispatched}}).catch(()=>undefined);
        }catch(error){
          const reason=error instanceof Error?error.message:"gateway_stream_error";
          if(!aborter.signal.aborted)failFrame("Gateway could not complete the request",reason==="gateway_deadline"?"gateway_timeout":"gateway_stream_error");
          await db.collection("requests").updateOne({requestId:rid},{$set:{status:"failed",completedAt:new Date(),failureStatuses:[reason],dispatchedAttempts:dispatched}}).catch(()=>undefined);
        }finally{close();}
      })();
    },
    async cancel(){cancelled=true;aborter.abort(new Error("client_disconnected"));if(heartbeat)clearInterval(heartbeat);if(deadline)clearTimeout(deadline);request.signal.removeEventListener("abort",onRequestAbort);await activeReader?.cancel().catch(()=>undefined);if(activeScopes&&activeLease)await releaseAdmission(activeScopes,activeLease).catch(()=>undefined);},
  });
  return new Response(stream,{headers});
}
export async function POST(request: Request) {
  const rid = request.headers.get("x-request-id") || `fr_${randomUUID()}`;
  let input: CanonicalChat;
  try { input = translateChatRequest(await readJson(request)); } catch (e) {
    if (e instanceof RequestValidationError) return jsonError(400, e.message, e.kind === "unsupported_parameter" ? "unsupported_parameter" : "invalid_request", rid, e.param);
    const m = e instanceof Error ? e.message : "Invalid request";
    return jsonError(m === "body_too_large" ? 413 : m === "unsupported_content_type"||m==="unsupported_encoding" ? 415 : 400, m, "invalid_request", rid);
  }
  const internalClient = consumeInternalClient(request);
  const auth = internalClient ? { key: internalClient } : await authenticateClient(request, "chat", input.model);
  if ("error" in auth) return jsonError(auth.error === "invalid_api_key" ? 401 : 403, auth.error === "invalid_api_key" ? "Invalid API key" : "API key cannot access this request", String(auth.error), rid);
  const alias = input.model.startsWith("fr-"); const category=input.model==="fr-auto"?await classifyAuto(input,String(auth.key._id),auth.key.allowJevRouting!==false):"code"; const declared = resolveCandidates(input.model,category); const candidates = declared.filter(p => supportsRequest(p,input));
  if (!candidates.length) return declared.length ? jsonError(400, "The selected model does not support one or more requested capabilities", "unsupported_capability", rid) : jsonError(404, "Unknown or unavailable model", "model_not_found", rid);
  const failures: UpstreamVerdict[] = [];let dispatched=0;
  const db = await getDb();
  if(input.stream===true)return streamChatResponse({request,rid,input,keyId:String(auth.key._id),candidates,alias,db});
  for (const profile of candidates.slice(0, 3)) {
    if(await isPersistedModelCoolingDown(db,profile.provider,profile.upstream)){failures.push(verdictFor(503,"503:model_overload_cooldown"));continue;}
    const credentials = getProviderCredentials().filter(c => c.provider === profile.provider);
    if (!credentials.length) continue;
    const ranked=await Promise.all(credentials.map(async c=>{const [h,b]=await Promise.all([db.collection<any>("credential_health").findOne({provider:profile.provider,fingerprint:c.fingerprint}),db.collection<any>("model_bindings").findOne({provider:profile.provider,model:profile.upstream,fingerprint:c.fingerprint})]);return{c,rank:b?.status==="healthy"?0:h?.authStatus==="healthy"?1:2,b}}));
    const ordered=[0,1,2].flatMap(rank=>{const group=ranked.filter(x=>x.rank===rank).map(x=>x.c);if(!group.length)return[];const start=(Date.now()+profile.id.length+rank)%group.length;return [...group.slice(start),...group.slice(0,start)]});
    for (const credential of ordered) {
      if(dispatched>=3)break;
      if(await isPersistedModelCoolingDown(db,profile.provider,profile.upstream)){failures.push(verdictFor(503,"503:model_overload_cooldown"));break;}
      const lease = `${rid}:${profile.id}:${credential.slot}`;
      const scopes=[`global`, `client:${auth.key._id}`, `provider:${profile.provider}:account:${credential.slot}`, `binding:${profile.id}:${credential.slot}`];
      let admitted = false;
      try {
        const health=await db.collection<any>("credential_health").findOne({provider:profile.provider,fingerprint:credential.fingerprint});if(health&&(health.paused===true||health.authStatus==="invalid"||(health.cooldownUntil&&new Date(health.cooldownUntil)>new Date())))continue;
        const binding=await db.collection<any>("model_bindings").findOne({provider:profile.provider,model:profile.upstream,fingerprint:credential.fingerprint});if(binding?.status==="unavailable"||(binding?.cooldownUntil&&new Date(binding.cooldownUntil)>new Date())||((input.response_format as any)?.type==="json_schema"&&binding?.schemaStatus==="failed")||(input.tools as any[]|undefined)?.some(t=>t.function?.strict===true&&binding?.schemaStatus==="failed"))continue;
        const admission = await checkAdmission(scopes, lease);
        if (!admission.allowed) continue; admitted = true;
        const body = providerRequestBody(profile,input,alias);
        dispatched++;
        const requestStartedAt=new Date();
        const upstream = await upstreamChat(profile, credential, body, request.signal);
        if (!upstream.ok || !upstream.body) {
          const verdict=classifyUpstream({status:upstream.status,providerCode:await upstreamErrorCode(upstream),retryAfter:upstream.headers.get("retry-after")});
          failures.push(verdict);await releaseAdmission(scopes,lease);
          await applyVerdict(db,verdict,{provider:profile.provider,model:profile.upstream,fingerprint:credential.fingerprint});
          if(verdict.overload)await recordModelOverload(db,profile.provider,profile.upstream);
          if(verdict.action!=="continue")break;
          continue;
        }
        await db.collection("credential_health").updateOne({provider:profile.provider,fingerprint:credential.fingerprint},{$set:{authStatus:"healthy",lastSuccessAt:new Date(),lastSuccessModel:profile.upstream}},{upsert:true});await db.collection("model_bindings").updateOne({provider:profile.provider,model:profile.upstream,fingerprint:credential.fingerprint},{$set:{status:"healthy",lastSuccessAt:new Date()},$unset:{cooldownUntil:"",reason:""}},{upsert:true});
        await clearModelOverload(db,profile.provider,profile.upstream,requestStartedAt);
        const record = { requestId: rid, keyId: String(auth.key._id), requestedModel: input.model, model: profile.id, provider: profile.provider, credentialSlot: credential.slot, status: "streaming", createdAt: new Date(), expiresAt:new Date(Date.now()+7*86400000), alias };
        void db.collection("requests").insertOne(record).catch(() => undefined);
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
        if(invalid){failures.push(verdictFor(200,invalid));await db.collection("model_bindings").updateOne({provider:profile.provider,model:profile.upstream,fingerprint:credential.fingerprint},{$set:{schemaStatus:"failed",schemaFailure:invalid,checkedAt:new Date()}},{upsert:true});continue;}
        if((input.response_format as any)?.type==="json_schema"||(input.tools as any[]|undefined)?.some(t=>t.function?.strict===true))await db.collection("model_bindings").updateOne({provider:profile.provider,model:profile.upstream,fingerprint:credential.fingerprint},{$set:{schemaStatus:"passed",schemaCheckedAt:new Date()},$unset:{schemaFailure:""}},{upsert:true});
        const choices = [{ index: 0, message: { role: "assistant", content: content || null, ...(toolCalls.size ? { tool_calls: [...toolCalls.values()] } : {}) }, finish_reason: finish || (toolCalls.size ? "tool_calls" : "stop") }];
        return Response.json({ id: (first as any)?.id || `chatcmpl-${rid}`, object: "chat.completion", created: (first as any)?.created || Math.floor(Date.now()/1000), model: input.model, choices, ...(usage?{usage}:{}) }, { headers: { "cache-control": "no-store", "x-request-id": rid, "x-freerouter-resolved-model": profile.id } });
      } catch (e) { if (admitted) await releaseAdmission(scopes, lease).catch(() => undefined); failures.push(verdictFor(null,e instanceof Error ? e.name : "error")); }
    }
    if (!alias||dispatched>=3) break;
  }
  void db.collection("requests").insertOne({requestId:rid,keyId:String(auth.key._id),requestedModel:input.model,status:"failed",failureStatuses:failures.map(f=>f.reason),dispatchedAttempts:dispatched,createdAt:new Date(),expiresAt:new Date(Date.now()+7*86400000)}).catch(()=>undefined);
  const summary=summarizeFailures(failures,dispatched);
  return jsonError(summary.status,summary.message,summary.code,rid);
}
