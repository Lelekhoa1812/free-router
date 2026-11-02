import { describe,expect,it } from "vitest";
import { decisionToSystemOne,systemOneToDecision } from "@/lib/jev";

describe("OpenAI Decisions ↔ TypeSafe System One adapter",()=>{
  it("uses opaque native IDs and restores typed choice values and ordered score levels",()=>{
    const {wire,maps}=decisionToSystemOne({model:"jev/jev-latest",input:"Ticket evidence",questions:[
      {type:"predicate",name:"urgent",instructions:"Is this urgent?"},
      {type:"choice",name:"route",instructions:"Choose a route",choices:[{value:true,description:"Engineering"},{value:"billing",description:"Billing"}]},
      {type:"score",name:"severity",instructions:"Rate severity",levels:[{label:"Low"},{label:"High"}]},
    ]});
    expect(wire).toEqual({model:"jev-latest",state:"Ticket evidence",questions:{q0:{type:"noul",instructions:"Is this urgent?"},q1:{type:"choice",instructions:"Choose a route",criteria:{o0:"Engineering",o1:"Billing"}},q2:{type:"score",instructions:"Rate severity",criteria:["Low","High"]}}});
    const result=systemOneToDecision({model:"jev-1.14.0",answers:{q0:{type:"noul",noul:.91},q1:{type:"choice",choice:"o0",confidence:.8,probabilities:{o0:.8,o1:.2}},q2:{type:"score",score:.6,confidence:.7,probabilities:{0:.4,1:.6}}},usage:{input_tokens:8,output_tokens:3}},maps,"jev/jev-latest");
    expect(result.model).toBe("jev/jev-1.14.0");expect(result.answers[1]).toMatchObject({type:"choice",name:"route",choice:true});expect(result.answers[2]).toMatchObject({score:.6,probabilities:[{value:0,label:"Low",probability:.4},{value:1,label:"High",probability:.6}]});
  });
  it("rejects malformed question sets and non-Jev model IDs",()=>{
    expect(()=>decisionToSystemOne({model:"gpt-6-luna",input:"x",questions:[]})).toThrow();
    expect(()=>decisionToSystemOne({model:"jev/jev-latest",input:"x",questions:[{type:"score",name:"s",instructions:"score",levels:[{label:"only one"}]}]})).toThrow(/2–10/);
    expect(()=>decisionToSystemOne({model:"jev/jev-latest",input:"x",questions:[{type:"predicate",name:"x",instructions:"yes"},{type:"predicate",name:"x",instructions:"yes"}]})).toThrow(/unique/);
  });
});
