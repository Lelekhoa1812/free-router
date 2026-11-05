import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks=vi.hoisted(()=>({
  getDb:vi.fn(),authenticateClient:vi.fn(),consumeInternalClient:vi.fn(),getProviderCredentials:vi.fn(),upstreamChat:vi.fn(),checkAdmission:vi.fn(),releaseAdmission:vi.fn(),reserveQuota:vi.fn(),settleQuota:vi.fn(),
}));

vi.mock("@/lib/db",()=>({getDb:mocks.getDb}));
vi.mock("@/lib/auth/client",()=>({authenticateClient:mocks.authenticateClient,consumeInternalClient:mocks.consumeInternalClient}));
vi.mock("@/lib/providers/credentials",()=>({getProviderCredentials:mocks.getProviderCredentials}));
vi.mock("@/lib/providers/openai",async()=>{const actual=await vi.importActual<any>("@/lib/providers/openai");return{...actual,upstreamChat:mocks.upstreamChat};});
vi.mock("@/lib/redis",()=>({checkAdmission:mocks.checkAdmission,releaseAdmission:mocks.releaseAdmission,getRedis:vi.fn(),useDailyBudgets:vi.fn()}));
vi.mock("@/lib/quota/ledger",async()=>{const actual=await vi.importActual<any>("@/lib/quota/ledger");return{...actual,reserveQuota:mocks.reserveQuota,settleQuota:mocks.settleQuota};});

import { POST } from "./route";
import { ALIASES, MODEL_BY_ID, type ModelProfile } from "@/lib/models/catalog";

const mistralRoleProbe: ModelProfile = {
  id: "mistral/mistral-role-probe", provider: "mistral", upstream: "mistral-role-probe", label: "Mistral role probe",
  context: null, maxOutput: null, text: "passed", tools: "passed", schema: "passed", vision: "unsupported",
  latency: "standard", status: "ready",
};

describe("Chat Completions streaming startup",()=>{
  beforeEach(()=>{
    vi.clearAllMocks();
    const collection={findOne:vi.fn().mockResolvedValue(null),updateOne:vi.fn().mockResolvedValue({}),insertOne:vi.fn().mockResolvedValue({}),deleteOne:vi.fn().mockResolvedValue({})};
    mocks.getDb.mockResolvedValue({collection:vi.fn(()=>collection)});
    mocks.authenticateClient.mockResolvedValue({key:{_id:"client-test",allowJevRouting:false}});
    mocks.consumeInternalClient.mockReturnValue(undefined);
    mocks.getProviderCredentials.mockReturnValue([{provider:"google",slot:1,secret:"test-secret",fingerprint:"test-fingerprint"}]);
    mocks.checkAdmission.mockResolvedValue({allowed:true});
    mocks.releaseAdmission.mockResolvedValue(undefined);
    mocks.reserveQuota.mockResolvedValue({allowed:true});
    mocks.settleQuota.mockResolvedValue(true);
  });
  afterEach(()=>vi.restoreAllMocks());

  it("opens SSE and emits a heartbeat before slow upstream headers arrive",async()=>{
    mocks.upstreamChat.mockImplementation(async()=>{
      await new Promise(resolve=>setTimeout(resolve,1200));
      const body=[
        `data: ${JSON.stringify({id:"chatcmpl-test",created:1,choices:[{index:0,delta:{role:"assistant"},finish_reason:null}]})}\n\n`,
        `data: ${JSON.stringify({id:"chatcmpl-test",created:1,choices:[{index:0,delta:{content:"FR_OK"},finish_reason:null}]})}\n\n`,
        `data: ${JSON.stringify({id:"chatcmpl-test",created:1,choices:[{index:0,delta:{},finish_reason:"stop"}]})}\n\n`,
        "data: [DONE]\n\n",
      ].join("");
      return new Response(body,{status:200,headers:{"content-type":"text/event-stream"}});
    });
    const started=Date.now();
    const response=await POST(new Request("https://freerouter.test/v1/chat/completions",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({model:"google/gemini-3.6-flash",messages:[{role:"user",content:"Reply with FR_OK"}],stream:true}),
    }));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader=response.body!.getReader();
    const first=await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("freerouter connected");
    expect(Date.now()-started).toBeLessThan(900);
    let output="";
    while(true){const item=await reader.read();if(item.done)break;output+=new TextDecoder().decode(item.value);}
    expect(output).toContain("FR_OK");
    expect(output).toContain("data: [DONE]");
    expect(mocks.upstreamChat).toHaveBeenCalledTimes(1);
  });

  it("skips Mistral for a mixed system/developer alias request and falls back to another provider",async()=>{
    const oldAlias=ALIASES["fr-code"];
    MODEL_BY_ID.set(mistralRoleProbe.id,mistralRoleProbe);
    ALIASES["fr-code"]=[mistralRoleProbe.id,"google/gemini-3.6-flash"];
    mocks.getProviderCredentials.mockReturnValue([{provider:"google",slot:1,secret:"test-secret",fingerprint:"test-fingerprint"}]);
    mocks.upstreamChat.mockResolvedValue(new Response([
      `data: ${JSON.stringify({choices:[{index:0,delta:{content:"FR_OK"},finish_reason:null}]})}\n\n`,
      `data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:"stop"}]})}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),{status:200,headers:{"content-type":"text/event-stream"}}));
    try {
      const response=await POST(new Request("https://freerouter.test/v1/chat/completions",{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({model:"fr-code",messages:[{role:"system",content:"System"},{role:"developer",content:"Developer"},{role:"user",content:"hello"}],stream:true}),
      }));
      expect(response.status).toBe(200);
      await response.text();
      expect(mocks.upstreamChat).toHaveBeenCalledOnce();
      expect(mocks.upstreamChat.mock.calls[0][0].provider).toBe("google");
    } finally {
      if(oldAlias) ALIASES["fr-code"]=oldAlias;
      MODEL_BY_ID.delete(mistralRoleProbe.id);
    }
  });

  it("returns unsupported-capability for an exact Mistral model with mixed system/developer roles",async()=>{
    MODEL_BY_ID.set(mistralRoleProbe.id,mistralRoleProbe);
    try {
      const response=await POST(new Request("https://freerouter.test/v1/chat/completions",{
        method:"POST",headers:{"content-type":"application/json"},
        body:JSON.stringify({model:mistralRoleProbe.id,messages:[{role:"system",content:"System"},{role:"developer",content:"Developer"},{role:"user",content:"hello"}]}),
      }));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({error:{code:"unsupported_capability"}});
      expect(mocks.upstreamChat).not.toHaveBeenCalled();
    } finally {
      MODEL_BY_ID.delete(mistralRoleProbe.id);
    }
  });

  it("keeps caller correlation ids out of admission and request accounting",async()=>{
    const insertOne=vi.fn().mockResolvedValue({});
    const collection={findOne:vi.fn().mockResolvedValue(null),updateOne:vi.fn().mockResolvedValue({}),insertOne,deleteOne:vi.fn().mockResolvedValue({})};
    mocks.getDb.mockResolvedValue({collection:vi.fn(()=>collection)});
    mocks.upstreamChat.mockResolvedValue(new Response([
      `data: ${JSON.stringify({choices:[{index:0,delta:{content:"FR_OK"},finish_reason:null}]})}\n\n`,
      `data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:"stop"}]})}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),{status:200,headers:{"content-type":"text/event-stream"}}));
    const response=await POST(new Request("https://freerouter.test/v1/chat/completions",{
      method:"POST",headers:{"content-type":"application/json","x-request-id":"caller-fixed-id"},
      body:JSON.stringify({model:"google/gemini-3.6-flash",messages:[{role:"user",content:"Reply FR_OK"}]}),
    }));
    expect(response.status).toBe(200);
    const lease=mocks.checkAdmission.mock.calls[0][1] as string;
    expect(lease).not.toContain("caller-fixed-id");
    expect(lease.startsWith("fr_")).toBe(true);
    const record=insertOne.mock.calls[0][0];
    expect(record.requestId).not.toBe("caller-fixed-id");
    expect(record.requestId.startsWith("fr_")).toBe(true);
    expect(response.headers.get("x-request-id")).toBe(record.requestId);
  });

  it("uses fr-auto low effort as a fast-tier hint without forwarding an unsupported effort field",async()=>{
    mocks.getProviderCredentials.mockReturnValue([{provider:"nvidia",slot:1,secret:"test-secret",fingerprint:"test-fingerprint"}]);
    mocks.upstreamChat.mockImplementation(async(profile,_credential,body)=>{
      expect(profile.id).toBe("nvidia/poolside/laguna-xs-2.1");
      expect(body.reasoning_effort).toBeUndefined();
      return new Response([
        `data: ${JSON.stringify({choices:[{index:0,delta:{content:"FR_OK"},finish_reason:null}]})}\n\n`,
        `data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:"stop"}]})}\n\n`,
        "data: [DONE]\n\n",
      ].join(""),{status:200,headers:{"content-type":"text/event-stream"}});
    });
    const response=await POST(new Request("https://freerouter.test/v1/chat/completions",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({model:"fr-auto",messages:[{role:"user",content:"A short question"}],reasoning_effort:"low",stream:true}),
    }));
    const reader=response.body!.getReader();let output="";
    while(true){const item=await reader.read();if(item.done)break;output+=new TextDecoder().decode(item.value);}
    expect(response.status).toBe(200);
    expect(output).toContain("FR_OK");
    expect(output).toContain("data: [DONE]");
    expect(mocks.upstreamChat).toHaveBeenCalledTimes(1);
  });

  it("routes verified Matilda streamed native tools through the OpenAI contract",async()=>{
    mocks.getProviderCredentials.mockReturnValue([{provider:"matilda",slot:1,secret:"test-secret",fingerprint:"matilda-fingerprint"}]);
    mocks.upstreamChat.mockImplementation(async(profile,_credential,body)=>{
      expect(profile.id).toBe("matilda/matilda");
      expect(body.tools).toHaveLength(1);
      expect(body.tool_choice).toBe("required");
      expect(body.parallel_tool_calls).toBe(false);
      return new Response([
        `data: ${JSON.stringify({id:"matilda-tool",model:"matilda",choices:[{index:0,delta:{tool_calls:[{index:0,id:"call_matilda",type:"function",function:{name:"smoke_echo",arguments:'{"value":"FR_TOOL"}'}}]},finish_reason:null}]})}\n\n`,
        `data: ${JSON.stringify({id:"matilda-tool",model:"matilda",choices:[{index:0,delta:{},finish_reason:"tool_calls"}]})}\n\n`,
        "data: [DONE]\n\n",
      ].join(""),{status:200,headers:{"content-type":"text/event-stream"}});
    });
    const response=await POST(new Request("https://freerouter.test/v1/chat/completions",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({
        model:"matilda/matilda",
        messages:[{role:"user",content:"Call smoke_echo with FR_TOOL."}],
        tools:[{type:"function",function:{name:"smoke_echo",parameters:{type:"object",properties:{value:{type:"string"}},required:["value"],additionalProperties:false}}}],
        tool_choice:"required",parallel_tool_calls:false,stream:true,
      }),
    }));
    const reader=response.body!.getReader();let output="";
    while(true){const item=await reader.read();if(item.done)break;output+=new TextDecoder().decode(item.value);}
    expect(response.status).toBe(200);
    expect(output).toContain('"name":"smoke_echo"');
    expect(output).toContain('"finish_reason":"tool_calls"');
    expect(output).toContain("data: [DONE]");
    expect(mocks.upstreamChat).toHaveBeenCalledTimes(1);
  });

  it("allows Matilda JSON mode through the OpenAI Chat route",async()=>{
    mocks.getProviderCredentials.mockReturnValue([{provider:"matilda",slot:1,secret:"test-secret",fingerprint:"matilda-fingerprint"}]);
    mocks.upstreamChat.mockImplementation(async(_profile,_credential,body)=>{
      expect(body.response_format).toEqual({type:"json_object"});
      return new Response([
        `data: ${JSON.stringify({choices:[{index:0,delta:{content:'{"ok":true}'},finish_reason:null}]})}\n\n`,
        `data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:"stop"}]})}\n\n`,
        "data: [DONE]\n\n",
      ].join(""),{status:200,headers:{"content-type":"text/event-stream"}});
    });
    const response=await POST(new Request("https://freerouter.test/v1/chat/completions",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({model:"matilda/matilda",messages:[{role:"user",content:"Return JSON."}],response_format:{type:"json_object"},stream:true}),
    }));
    const reader=response.body!.getReader();let output="";
    while(true){const item=await reader.read();if(item.done)break;output+=new TextDecoder().decode(item.value);}
    expect(response.status).toBe(200);
    const event=output.split(/\r?\n/).find((line)=>line.startsWith("data: {"));
    expect(JSON.parse(event!.slice(6)).choices[0].delta.content).toBe('{"ok":true}');
    expect(output).toContain("data: [DONE]");
    expect(mocks.upstreamChat).toHaveBeenCalledTimes(1);
  });

  it("uses the outer Responses permission for a trusted adapter request",async()=>{
    mocks.consumeInternalClient.mockReturnValueOnce({_id:"responses-only-client",allowJevRouting:false});
    mocks.upstreamChat.mockResolvedValue(new Response([
      `data: ${JSON.stringify({choices:[{index:0,delta:{content:"FR_OK"},finish_reason:null}]})}\n\n`,
      `data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:"stop"}]})}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),{status:200,headers:{"content-type":"text/event-stream"}}));
    const response=await POST(new Request("https://freerouter.test/v1/chat/completions",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({model:"google/gemini-3.6-flash",messages:[{role:"user",content:"Reply FR_OK"}],stream:false}),
    }));
    expect(response.status).toBe(200);
    expect(mocks.authenticateClient).not.toHaveBeenCalled();
  });

  it("returns a distinct quota error and Retry-After when the local ledger denies a request",async()=>{
    mocks.reserveQuota.mockResolvedValue({allowed:false,reason:"request_day",retryAfterMs:120_000});
    const response=await POST(new Request("https://freerouter.test/v1/chat/completions",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({model:"google/gemini-3.6-flash",messages:[{role:"user",content:"Reply briefly"}]}),
    }));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("120");
    await expect(response.json()).resolves.toMatchObject({error:{code:"quota_exhausted"}});
    expect(mocks.upstreamChat).not.toHaveBeenCalled();
    expect(mocks.releaseAdmission).toHaveBeenCalledTimes(1);
  });

  it("releases admission when quota reservation fails before dispatch",async()=>{
    mocks.reserveQuota.mockRejectedValue(new Error("quota ledger unavailable"));
    const response=await POST(new Request("https://freerouter.test/v1/chat/completions",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({model:"google/gemini-3.6-flash",messages:[{role:"user",content:"Reply briefly"}],stream:true}),
    }));
    await response.text();
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    expect(mocks.upstreamChat).not.toHaveBeenCalled();
    expect(mocks.releaseAdmission).toHaveBeenCalledTimes(1);
  });

  it("streams a quota error frame when the local ledger denies before dispatch",async()=>{
    mocks.reserveQuota.mockResolvedValue({allowed:false,reason:"request_minute",retryAfterMs:30_000});
    const response=await POST(new Request("https://freerouter.test/v1/chat/completions",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({model:"google/gemini-3.6-flash",messages:[{role:"user",content:"Reply briefly"}],stream:true}),
    }));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const output=await response.text();
    expect(output).toContain('"code":"quota_exhausted"');
    expect(mocks.upstreamChat).not.toHaveBeenCalled();
  });

  it("settles a completed non-streaming reservation with its usage",async()=>{
    const reservation={id:"fr_test",target:{provider:"google",group:"default",model:"google/gemini-3.6-flash",scope:"model",limits:{rpm:5},timeZone:"UTC"},estimate:100,mode:"enforce",keys:["a","b","c","d"],resetAt:new Date(),minuteResetSeconds:60,dayResetSeconds:60,dayTtl:3600};
    mocks.reserveQuota.mockResolvedValue({allowed:true,reservation});
    mocks.upstreamChat.mockResolvedValue(new Response([
      `data: ${JSON.stringify({choices:[{index:0,delta:{content:"FR_OK"},finish_reason:null}]})}\n\n`,
      `data: ${JSON.stringify({choices:[{index:0,delta:{},finish_reason:"stop"}],usage:{prompt_tokens:2,completion_tokens:1,total_tokens:3}})}\n\n`,
      "data: [DONE]\n\n",
    ].join(""),{status:200,headers:{"content-type":"text/event-stream"}}));
    const response=await POST(new Request("https://freerouter.test/v1/chat/completions",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({model:"google/gemini-3.6-flash",messages:[{role:"user",content:"Reply FR_OK"}]}),
    }));
    expect(response.status).toBe(200);
    expect(mocks.settleQuota).toHaveBeenCalledWith(reservation,expect.objectContaining({outcome:"completed"}));
  });

  it("stops credential rotation and records a shared breaker after a model 503",async()=>{
    mocks.getProviderCredentials.mockReturnValue([
      {provider:"google",slot:1,secret:"key-1",fingerprint:"fingerprint-1"},
      {provider:"google",slot:2,secret:"key-2",fingerprint:"fingerprint-2"},
      {provider:"google",slot:3,secret:"key-3",fingerprint:"fingerprint-3"},
    ]);
    const updates=vi.fn().mockResolvedValue({});
    const collection={findOne:vi.fn().mockResolvedValue(null),updateOne:updates,insertOne:vi.fn().mockResolvedValue({}),deleteOne:vi.fn().mockResolvedValue({})};
    mocks.getDb.mockResolvedValue({collection:vi.fn(()=>collection)});
    mocks.upstreamChat.mockResolvedValue(new Response(JSON.stringify({error:{message:"model experiencing high demand"}}),{status:503}));
    const response=await POST(new Request("https://freerouter.test/v1/chat/completions",{
      method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({model:"google/gemini-3.6-flash",messages:[{role:"user",content:"Reply briefly"}]}),
    }));
    expect(response.status).toBe(503);
    expect(mocks.upstreamChat).toHaveBeenCalledTimes(1);
    expect(updates).toHaveBeenCalledWith(
      {provider:"google",model:"gemini-3.6-flash"},
      expect.any(Array),
      {upsert:true},
    );
  });
});
