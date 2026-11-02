import { env } from "@/lib/env";
export interface DecisionQuestion { type: "predicate"|"choice"|"score"; name: string; instructions: string; choices?: {value: unknown;description?:string}[]; levels?:{label:string;description?:string}[]; }
export function decisionToSystemOne(input:any) {
  const allowed=new Set(["model","input","questions","stream"]);const unknown=Object.keys(input||{}).find(k=>!allowed.has(k));if(unknown)throw new Error(`Unsupported Decisions field: ${unknown}`);
  const model=String(input.model||"jev/jev-latest");if(!["jev/jev-latest","jev/jev-preview","jev-latest","jev-preview"].includes(model))throw new Error("Use a Jev model ID: jev/jev-latest or jev/jev-preview");
  if(input.input===undefined||input.input===null)throw new Error("input is required");
  if (!Array.isArray(input.questions) || input.questions.length < 1 || input.questions.length > 400) throw new Error("questions must contain between 1 and 400 entries");
  const names=new Set<string>(); const maps:Record<string,any>={}; const questions:Record<string,any>={};
  input.questions.forEach((q:any,index:number)=>{
    if(!q||typeof q.name!=="string"||!q.name||names.has(q.name))throw new Error("Each question needs a unique non-empty name"); names.add(q.name);
    const id=`q${index}`;maps[id]={name:q.name,type:q.type,nativeType:q.type==="predicate"?"noul":q.type};
    if(q.type==="predicate") questions[id]={type:"noul",instructions:q.instructions};
    else if(q.type==="choice"){
      if(!Array.isArray(q.choices)||q.choices.length<2||q.choices.length>255)throw new Error(`Choice question ${q.name} must have 2–255 choices`);
      maps[id].choices={};const criteria:Record<string,string>={};
      q.choices.forEach((choice:any,j:number)=>{if(typeof choice?.value!=="string"&&typeof choice?.value!=="boolean")throw new Error(`Choice values for ${q.name} must be strings or booleans`);const option=`o${j}`;maps[id].choices[option]=choice.value;criteria[option]=String(choice.description||String(choice.value));});
      questions[id]={type:"choice",instructions:q.instructions,criteria};
    } else if(q.type==="score"){
      if(!Array.isArray(q.levels)||q.levels.length<2||q.levels.length>10)throw new Error(`Score question ${q.name} must have 2–10 levels`);
      maps[id].levels=q.levels;questions[id]={type:"score",instructions:q.instructions,criteria:q.levels.map((l:any)=>`${l.label}${l.description?`: ${l.description}`:""}`)};
    } else throw new Error(`Unsupported decision question type for ${q.name}`);
    if(typeof q.instructions!=="string"||!q.instructions.trim())throw new Error(`Question ${q.name} requires instructions`);
  });
  return {wire:{model:model.replace(/^jev\//,""),state:input.input,questions},maps};
}
export function systemOneToDecision(result:any,maps:Record<string,any>,requestedModel:string) {
  const probabilitySet=(p:Record<string,number>)=>{const pairs=Object.entries(p).map(([k,v])=>[k,Number(v)] as const);if(!pairs.length||pairs.some(([,v])=>!Number.isFinite(v)||v<0||v>1)||Math.abs(pairs.reduce((a,[,v])=>a+v,0)-1)>.02)throw new Error("Jev returned an invalid probability distribution");return pairs};
  const answers=Object.entries(maps).map(([id,m]:[string,any])=>{const answer=result.answers?.[id];if(!answer||answer.type!==m.nativeType)throw new Error("Jev returned an incomplete or mismatched answer");if(m.type==="predicate"){const p=Number(answer.noul);if(!Number.isFinite(p)||p<0||p>1)throw new Error("Jev returned an invalid predicate probability");return {type:"predicate",name:m.name,probability:p}}
    const confidence=Number(answer.confidence);if(!Number.isFinite(confidence)||confidence<0||confidence>1)throw new Error("Jev returned invalid confidence");
    if(m.type==="choice"){const choice=m.choices?.[answer.choice];if(choice===undefined)throw new Error("Jev selected an unknown choice");const p=probabilitySet(answer.probabilities||{});return {type:"choice",name:m.name,choice,probabilities:p.map(([k,v])=>({value:m.choices?.[k],probability:v})),confidence}}
    const score=Number(answer.score);if(!Number.isFinite(score)||score<0||score>m.levels.length-1)throw new Error("Jev returned an invalid fractional score");const p=probabilitySet(answer.probabilities||{});return {type:"score",name:m.name,score,probabilities:p.map(([k,v])=>({value:Number(k),label:m.levels?.[Number(k)]?.label,probability:v})),confidence};
  });
  return {id:`decision_${Date.now()}`,object:"decision",model:`jev/${result.model||requestedModel.replace(/^jev\//,"")}`,answers,usage:result.usage?{input_tokens:result.usage.input_tokens,output_tokens:result.usage.output_tokens}:undefined};
}
export async function callSystemOne(body:unknown,headers?:HeadersInit,timeoutMs=90000) {
  if(!env.jevKey)throw new Error("JEV_TYPESAFE_API_KEY is not configured");
  return fetch("https://api.typesafe.ai/v1/systemone",{method:"POST",headers:{authorization:`Bearer ${env.jevKey}`,"content-type":"application/json",...(headers||{})},body:JSON.stringify(body),cache:"no-store",signal:AbortSignal.timeout(timeoutMs)});
}
