import { describe,expect,it } from "vitest";
import { translateChatRequest, buildProviderChatBody } from "@/lib/providers/openai";
import { MODEL_BY_ID } from "@/lib/models/catalog";
describe("Chat Completions request validation",()=>{
  it("accepts a minimal OpenAI chat request without changing message order",()=>{const input={model:"fr-code",messages:[{role:"system",content:"You are helpful."},{role:"user",content:"Hello"}],stream:true};expect(translateChatRequest(input)).toMatchObject(input)});
  it("rejects unknown fields instead of silently dropping them",()=>{expect(()=>translateChatRequest({model:"fr-auto",messages:[{role:"user",content:"x"}],logit_bias:{}})).toThrow(/Unsupported request field/)});
  it("rejects unsupported n, conflicting token limits, and Chat storage",()=>{const base={model:"fr-auto",messages:[{role:"user",content:"x"}]};expect(()=>translateChatRequest({...base,n:2})).toThrow(/Unsupported request field/);expect(()=>translateChatRequest({...base,max_tokens:5,max_completion_tokens:5})).toThrow(/only one/);expect(()=>translateChatRequest({...base,store:true})).toThrow(/Responses API/)});
  it("keeps every upstream LLM request streamed, normalizes output limits, and bounds GLM reasoning by default",()=>{const profile=MODEL_BY_ID.get("nvidia/z-ai/glm-5.3-flash")!;expect(buildProviderChatBody(profile,{model:"fr-code",messages:[],max_completion_tokens:123,store:false,prompt_cache_key:"scoped"})).toEqual({model:"z-ai/glm-5.3-flash",messages:[],reasoning_effort:"low",max_tokens:123,stream:true})});
  it("preserves the caller's explicit GLM reasoning effort",()=>{const profile=MODEL_BY_ID.get("nvidia/z-ai/glm-5.3-flash")!;expect(buildProviderChatBody(profile,{model:profile.id,messages:[],reasoning_effort:"high"})).toMatchObject({reasoning_effort:"high",stream:true})});
});
