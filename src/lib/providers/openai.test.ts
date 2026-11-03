import { describe,expect,it } from "vitest";
import { translateChatRequest, buildProviderChatBody, completionToSse } from "@/lib/providers/openai";
import { MODEL_BY_ID, publicModels } from "@/lib/models/catalog";
describe("Chat Completions request validation",()=>{
  it("accepts a minimal OpenAI chat request without changing message order",()=>{const input={model:"fr-code",messages:[{role:"system",content:"You are helpful."},{role:"user",content:"Hello"}],stream:true};expect(translateChatRequest(input)).toMatchObject(input)});
  it("rejects unknown fields instead of silently dropping them",()=>{expect(()=>translateChatRequest({model:"fr-auto",messages:[{role:"user",content:"x"}],logit_bias:{}})).toThrow(/Unsupported request field/)});
  it("rejects unsupported n, conflicting token limits, and Chat storage",()=>{const base={model:"fr-auto",messages:[{role:"user",content:"x"}]};expect(()=>translateChatRequest({...base,n:2})).toThrow(/Unsupported request field/);expect(()=>translateChatRequest({...base,max_tokens:5,max_completion_tokens:5})).toThrow(/only one/);expect(()=>translateChatRequest({...base,store:true})).toThrow(/Responses API/)});
  it("keeps every upstream LLM request streamed, normalizes output limits, and bounds GLM reasoning by default",()=>{const profile=MODEL_BY_ID.get("nvidia/z-ai/glm-5.3-flash")!;expect(buildProviderChatBody(profile,{model:"fr-code",messages:[],max_completion_tokens:123,store:false,prompt_cache_key:"scoped"})).toEqual({model:"z-ai/glm-5.3-flash",messages:[],reasoning_effort:"low",max_tokens:123,stream:true})});
  it("preserves the caller's explicit GLM reasoning effort",()=>{const profile=MODEL_BY_ID.get("nvidia/z-ai/glm-5.3-flash")!;expect(buildProviderChatBody(profile,{model:profile.id,messages:[],reasoning_effort:"high"})).toMatchObject({reasoning_effort:"high",stream:true})});
});

describe("Matilda (Maincode) provider compatibility",()=>{
  const matilda=MODEL_BY_ID.get("matilda/matilda")!;
  it("is registered as ready and does not claim tools or vision",()=>{
    expect(matilda).toBeDefined();
    expect(matilda.status).toBe("ready");
    expect(matilda.tools).toBe("unsupported");
    expect(matilda.vision).toBe("unsupported");
  });
  it("is published once its gateway path is certified",()=>{
    expect(publicModels().map((model) => model.id)).toContain("matilda/matilda");
  });
  it("sends only the fields Maincode accepts and keeps upstream streaming enabled",()=>{
    const body=buildProviderChatBody(matilda,{model:matilda.id,messages:[{role:"user",content:"hi"}],temperature:0.2,top_p:0.9,stop:["x"],tools:[{type:"function",function:{name:"f",parameters:{}}}],tool_choice:"auto",parallel_tool_calls:true,reasoning_effort:"high",stream_options:{include_usage:true},user:"u",max_completion_tokens:64,response_format:{type:"json_schema",json_schema:{name:"x",schema:{type:"object"}}}});
    expect(body).toEqual({model:"matilda",messages:[{role:"user",content:"hi"}],stream:true,max_tokens:64,response_format:{type:"json_schema",json_schema:{name:"x",schema:{type:"object"}}}});
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
});
