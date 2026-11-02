import { describe,expect,it } from "vitest";
import { ALIASES,MODEL_BY_ID,MODEL_CATALOG,publicModels } from "@/lib/models/catalog";
describe("model registry",()=>{
  it("keeps every alias binding traceable to an explicit catalog entry",()=>{for(const [alias,ids] of Object.entries(ALIASES)){expect(alias).toMatch(/^fr-/);for(const id of ids)expect(MODEL_BY_ID.has(id),`${alias} -> ${id}`).toBe(true)}});
  it("does not publish unavailable, restricted, or experimental candidates",()=>{const listed=new Set(publicModels().map(m=>m.id));for(const model of MODEL_CATALOG.filter(m=>m.status!=="ready"||m.text!=="passed"))expect(listed.has(model.id)).toBe(false)});
  it("keeps Jev out of the default chat model list",()=>{expect(publicModels().some(m=>m.id.startsWith("jev/"))).toBe(false)});
});
