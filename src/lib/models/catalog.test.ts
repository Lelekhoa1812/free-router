import { describe,expect,it } from "vitest";
import { ALIASES,MODEL_BY_ID,MODEL_CATALOG,publicModels } from "@/lib/models/catalog";
describe("model registry",()=>{
  it("keeps every alias binding traceable to an explicit catalog entry",()=>{for(const [alias,ids] of Object.entries(ALIASES)){expect(alias).toMatch(/^fr-/);for(const id of ids)expect(MODEL_BY_ID.has(id),`${alias} -> ${id}`).toBe(true)}});
  it("does not publish unavailable, restricted, or experimental candidates",()=>{const listed=new Set(publicModels().map(m=>m.id));for(const model of MODEL_CATALOG.filter(m=>m.status!=="ready"||m.text!=="passed"))expect(listed.has(model.id)).toBe(false)});
  it("keeps Jev out of the default chat model list",()=>{expect(publicModels().some(m=>m.id.startsWith("jev/"))).toBe(false)});
  it("keeps explicitly removed models out of the registry and routing aliases",()=>{
    const removed=[
      "google/gemini-2.5-flash","google/gemini-2.5-flash-lite","google/gemini-2.5-pro",
      "nvidia/nvidia/nemotron-3.5-lightning-30b-a3b","nvidia/moonshotai/kimi-k2.6",
      "nvidia/nvidia/nemotron-nano-3-30b-a3b","nvidia/nvidia/nemotron-3-super-120b-a12b",
      "openrouter/thinkingmachines/inkling-small:free","openrouter/thinkingmachines/inkling:free",
      "google/gemini-flash-latest",
    ];
    for(const id of removed){
      expect(MODEL_BY_ID.has(id),id).toBe(false);
      expect(Object.values(ALIASES).flat(),id).not.toContain(id);
      expect(publicModels().map(m=>m.id),id).not.toContain(id);
    }
  });
  it("retains only a successfully streamed Google floating alias as experimental",()=>{
    const id="google/gemini-flash-lite-latest";
    expect(MODEL_BY_ID.get(id)?.status).toBe("experimental");
    expect(publicModels().map(m=>m.id)).not.toContain(id);
  });
  it("keeps GLM-5.3-Flash out of public routing until a deployed gateway stream is verified",()=>{
    const id="nvidia/z-ai/glm-5.3-flash";
    expect(MODEL_BY_ID.get(id)?.status).toBe("experimental");
    expect(publicModels().map(m=>m.id)).not.toContain(id);
    expect(ALIASES["fr-code"]).not.toContain(id);
  });
});
