import { describe,expect,it,vi } from "vitest";
import { translateChatRequest, buildProviderChatBody, completionToSse, upstreamChat } from "@/lib/providers/openai";
import { MODEL_BY_ID, publicModels, type ModelProfile } from "@/lib/models/catalog";
describe("Chat Completions request validation",()=>{
  it("accepts a minimal OpenAI chat request without changing message order",()=>{const input={model:"fr-code",messages:[{role:"system",content:"You are helpful."},{role:"user",content:"Hello"}],stream:true};expect(translateChatRequest(input)).toMatchObject(input)});
  it("rejects unknown fields instead of silently dropping them",()=>{expect(()=>translateChatRequest({model:"fr-auto",messages:[{role:"user",content:"x"}],logit_bias:{}})).toThrow(/Unsupported request field/)});
  it("rejects unsupported n, conflicting token limits, and Chat storage",()=>{const base={model:"fr-auto",messages:[{role:"user",content:"x"}]};expect(()=>translateChatRequest({...base,n:2})).toThrow(/Unsupported request field/);expect(()=>translateChatRequest({...base,max_tokens:5,max_completion_tokens:5})).toThrow(/only one/);expect(()=>translateChatRequest({...base,store:true})).toThrow(/Responses API/)});
  it("keeps every upstream LLM request streamed, normalizes output limits, and bounds GLM reasoning by default",()=>{const profile=MODEL_BY_ID.get("nvidia/z-ai/glm-5.3-flash")!;expect(buildProviderChatBody(profile,{model:"fr-code",messages:[],max_completion_tokens:123,store:false,prompt_cache_key:"scoped"})).toEqual({model:"z-ai/glm-5.3-flash",messages:[],reasoning_effort:"low",max_tokens:123,stream:true})});
  it("preserves the caller's explicit GLM reasoning effort",()=>{const profile=MODEL_BY_ID.get("nvidia/z-ai/glm-5.3-flash")!;expect(buildProviderChatBody(profile,{model:profile.id,messages:[],reasoning_effort:"high"})).toMatchObject({reasoning_effort:"high",stream:true})});
});

describe("Matilda (Maincode) provider compatibility",()=>{
  const matilda=MODEL_BY_ID.get("matilda/matilda")!;
  it("is registered as ready with only directly verified capabilities",()=>{
    expect(matilda).toBeDefined();
    expect(matilda.status).toBe("ready");
    expect(matilda.tools).toBe("passed");
    expect(matilda.schema).toBe("passed");
    expect(matilda.vision).toBe("unsupported");
  });
  it("is published once its gateway path is certified",()=>{
    expect(publicModels().map((model) => model.id)).toContain("matilda/matilda");
  });
  it("maps verified OpenAI tool, JSON and output fields while keeping upstream streaming enabled",()=>{
    const body=buildProviderChatBody(matilda,{model:matilda.id,messages:[{role:"user",content:"hi"}],temperature:0.2,top_p:0.9,stop:["x"],tools:[{type:"function",function:{name:"f",parameters:{}}}],tool_choice:"auto",parallel_tool_calls:true,reasoning_effort:"high",stream_options:{include_usage:true},user:"u",max_completion_tokens:64,response_format:{type:"json_schema",json_schema:{name:"x",schema:{type:"object"}}}});
    expect(body).toEqual({model:"matilda",messages:[{role:"user",content:"hi"}],stream:true,max_tokens:64,response_format:{type:"json_schema",json_schema:{name:"x",schema:{type:"object"}}},tools:[{type:"function",function:{name:"f",parameters:{}}}],tool_choice:"auto",parallel_tool_calls:true});
  });
  it("forwards OpenAI JSON mode and preserves system and developer messages",()=>{
    const messages=[{role:"system",content:"System instruction"},{role:"developer",content:"Developer instruction"},{role:"user",content:"Hello"}];
    expect(buildProviderChatBody(matilda,{model:matilda.id,messages,response_format:{type:"json_object"}})).toEqual({model:"matilda",messages,stream:true,response_format:{type:"json_object"}});
  });
  it("enforces Maincode's per-message and per-request limits",()=>{
    expect(()=>buildProviderChatBody(matilda,{model:matilda.id,messages:[{role:"user",content:"x".repeat(16001)}]})).toThrow(/16,000/);
    expect(()=>buildProviderChatBody(matilda,{model:matilda.id,messages:Array.from({length:5},()=>({role:"user",content:"x".repeat(14000)}))})).toThrow(/65,536/);
  });
  it("converts a JSON completion fallback into OpenAI chat SSE",async()=>{
    const response=completionToSse({id:"cmpl_1",created:1,model:"matilda",choices:[{message:{content:"ok"},finish_reason:"stop"}],usage:{prompt_tokens:3,completion_tokens:1,total_tokens:4}},"matilda");
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const events=(await response.text()).trim().split("\n\n");
    expect(events.at(-1)).toBe("data: [DONE]");
    expect(JSON.parse(events[0].replace(/^data: /,""))).toMatchObject({object:"chat.completion.chunk",model:"matilda",choices:[{delta:{content:"ok"},finish_reason:null}]});
    expect(JSON.parse(events[1].replace(/^data: /,""))).toMatchObject({choices:[{delta:{},finish_reason:"stop"}]});
    expect(JSON.parse(events[2].replace(/^data: /,""))).toMatchObject({choices:[],usage:{total_tokens:4}});
    const native=completionToSse({id:"cmpl_2",created:1,choices:[{message:{content:"ok"}}],usage:{input_tokens:3,output_tokens:1}},"matilda");
    const nativeEvents=(await native.text()).trim().split("\n\n");
    expect(JSON.parse(nativeEvents[2].replace(/^data: /,""))).toMatchObject({usage:{prompt_tokens:3,completion_tokens:1,total_tokens:4}});
  });
  it("preserves tool calls when bridging a non-SSE Matilda completion",async()=>{
    const response=completionToSse({id:"cmpl_tool",choices:[{message:{content:null,tool_calls:[{id:"call_1",type:"function",function:{name:"lookup",arguments:'{"id":1}'}}]},finish_reason:"tool_calls"}]},"matilda");
    const events=(await response.text()).trim().split("\n\n").filter((event)=>event.startsWith("data: {")).map((event)=>JSON.parse(event.slice(6)));
    expect(events[1].choices[0].delta.tool_calls[0]).toMatchObject({index:0,id:"call_1",type:"function",function:{name:"lookup",arguments:'{"id":1}'}});
    expect(events[2].choices[0].finish_reason).toBe("tool_calls");
  });
});

describe("Mistral OpenAI-compatible provider transport",()=>{
  const mistral: ModelProfile={id:"mistral/ministral-test",provider:"mistral",upstream:"ministral-test",label:"Ministral test",context:null,maxOutput:null,text:"unknown",tools:"unknown",schema:"unknown",vision:"unknown",latency:"standard",status:"experimental"};
  it("maps developer-only instructions to Mistral's supported system role",()=>{
    const messages=[{role:"developer",content:"Follow these rules."},{role:"user",content:"hello"}];
    expect(buildProviderChatBody(mistral,{model:mistral.id,messages})).toMatchObject({messages:[{role:"system",content:"Follow these rules."},{role:"user",content:"hello"}]});
  });
  it("rejects combined system and developer instructions to preserve their priority distinction",()=>{
    expect(()=>buildProviderChatBody(mistral,{model:mistral.id,messages:[{role:"system",content:"System"},{role:"developer",content:"Developer"},{role:"user",content:"hello"}]})).toThrow(/cannot preserve separate system and developer instruction priority/);
  });
  it("uses the Mistral v1 chat endpoint, Bearer auth and streamed OpenAI request body",async()=>{
    const fetchMock=vi.spyOn(globalThis,"fetch").mockResolvedValue(new Response("",{status:200}));
    try {
      await upstreamChat(mistral,{provider:"mistral",slot:1,label:"Mistral key",secret:"test-secret",fingerprint:"fp"},{model:mistral.id,messages:[{role:"user",content:"hello"}],tools:[{type:"function",function:{name:"lookup",parameters:{type:"object"}}}],tool_choice:"required"});
      expect(fetchMock).toHaveBeenCalledOnce();
      const [url,init]=fetchMock.mock.calls[0];
      expect(url).toBe("https://api.mistral.ai/v1/chat/completions");
      expect((init?.headers as Record<string,string>).authorization).toBe("Bearer test-secret");
      expect(JSON.parse(String(init?.body))).toEqual({model:"ministral-test",messages:[{role:"user",content:"hello"}],tools:[{type:"function",function:{name:"lookup",parameters:{type:"object"}}}],tool_choice:"required",stream:true});
    } finally { fetchMock.mockRestore(); }
  });
});

describe("ZenMux and OrcaRouter provider compatibility", () => {
  it("registers zenmux and orcarouter model profiles", () => {
    const zenmux = MODEL_BY_ID.get("zenmux/deepseek/deepseek-v4-flash");
    const orcarouter = MODEL_BY_ID.get("orcarouter/orcarouter/free");
    expect(zenmux).toBeDefined();
    expect(zenmux?.provider).toBe("zenmux");
    expect(orcarouter).toBeDefined();
    expect(orcarouter?.provider).toBe("orcarouter");
  });

  it("builds standard OpenAI-compatible chat bodies with streaming", () => {
    const zenmux = MODEL_BY_ID.get("zenmux/deepseek/deepseek-v4-flash")!;
    const body = buildProviderChatBody(zenmux, {
      model: zenmux.id,
      messages: [{ role: "user", content: "hello" }],
      max_completion_tokens: 100,
    });
    expect(body).toEqual({
      model: "deepseek/deepseek-v4-flash",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 100,
      stream: true,
    });
  });
});
