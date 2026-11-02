import { describe,expect,it } from "vitest";
import { translateChatRequest } from "@/lib/providers/openai";
describe("Chat Completions request validation",()=>{
  it("accepts a minimal OpenAI chat request without changing message order",()=>{const input={model:"fr-code",messages:[{role:"system",content:"You are helpful."},{role:"user",content:"Hello"}],stream:true};expect(translateChatRequest(input)).toMatchObject(input)});
  it("rejects unknown fields instead of silently dropping them",()=>{expect(()=>translateChatRequest({model:"fr-auto",messages:[{role:"user",content:"x"}],logit_bias:{}})).toThrow(/Unsupported request field/)});
  it("rejects unsupported n, conflicting token limits, and Chat storage",()=>{const base={model:"fr-auto",messages:[{role:"user",content:"x"}]};expect(()=>translateChatRequest({...base,n:2})).toThrow(/Unsupported request field/);expect(()=>translateChatRequest({...base,max_tokens:5,max_completion_tokens:5})).toThrow(/only one/);expect(()=>translateChatRequest({...base,store:true})).toThrow(/Responses API/)});
});
