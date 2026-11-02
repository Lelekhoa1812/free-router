import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks=vi.hoisted(()=>({
  getDb:vi.fn(),authenticateClient:vi.fn(),getProviderCredentials:vi.fn(),upstreamChat:vi.fn(),checkAdmission:vi.fn(),releaseAdmission:vi.fn(),
}));

vi.mock("@/lib/db",()=>({getDb:mocks.getDb}));
vi.mock("@/lib/auth/client",()=>({authenticateClient:mocks.authenticateClient}));
vi.mock("@/lib/env",async()=>{const actual=await vi.importActual<any>("@/lib/env");return{...actual,getProviderCredentials:mocks.getProviderCredentials};});
vi.mock("@/lib/providers/openai",async()=>{const actual=await vi.importActual<any>("@/lib/providers/openai");return{...actual,upstreamChat:mocks.upstreamChat};});
vi.mock("@/lib/redis",()=>({checkAdmission:mocks.checkAdmission,releaseAdmission:mocks.releaseAdmission,getRedis:vi.fn(),useDailyBudgets:vi.fn()}));

import { POST } from "./route";

describe("Chat Completions streaming startup",()=>{
  beforeEach(()=>{
    vi.clearAllMocks();
    const collection={findOne:vi.fn().mockResolvedValue(null),updateOne:vi.fn().mockResolvedValue({}),insertOne:vi.fn().mockResolvedValue({})};
    mocks.getDb.mockResolvedValue({collection:vi.fn(()=>collection)});
    mocks.authenticateClient.mockResolvedValue({key:{_id:"client-test",allowJevRouting:false}});
    mocks.getProviderCredentials.mockReturnValue([{provider:"google",slot:1,secret:"test-secret",fingerprint:"test-fingerprint"}]);
    mocks.checkAdmission.mockResolvedValue({allowed:true});
    mocks.releaseAdmission.mockResolvedValue(undefined);
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
});
