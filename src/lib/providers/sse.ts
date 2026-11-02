import { randomUUID } from "node:crypto";

export function normalizeChatEvent(event:any,model:string,state:{toolIndex:Map<string,number>;toolCallId:Map<string,string>;toolIds:Map<number,Set<string>>;finished:Set<number>},includeUsage:boolean) {
  if(!event||typeof event!=="object")return null;
  if(Array.isArray(event.choices)){
    if(!includeUsage&&event.choices.length===0&&event.usage)return null;
    const choices=[];
    for(const original of event.choices){const choice={...original,index:Number(original.index||0),delta:{...(original.delta||{})}};const cidx=choice.index;
      if(state.finished.has(cidx)){continue;}
      if(Array.isArray(choice.delta.tool_calls)){choice.delta.tool_calls=choice.delta.tool_calls.map((call:any)=>{const identity=String(call.id||`anonymous-${cidx}-${call.index??call.function?.name??randomUUID()}`);let index=state.toolIndex.get(identity);if(index===undefined){index=call.index===undefined?state.toolIndex.size:Number(call.index);state.toolIndex.set(identity,index);}let ids=state.toolIds.get(cidx);if(!ids){ids=new Set();state.toolIds.set(cidx,ids);}const stableId=call.id||state.toolCallId.get(identity)||`call_${randomUUID().replaceAll("-","")}`;state.toolCallId.set(identity,stableId);ids.add(stableId);return {...call,index,id:stableId};});}
      if(choice.finish_reason){if(choice.finish_reason==="stop"&&(state.toolIds.get(cidx)?.size||0)>0)choice.finish_reason="tool_calls";state.finished.add(cidx);}choices.push(choice);
    }
    event={...event,model,choices};
    if(!choices.length&&!event.usage)return null;
  } else if(typeof event.model==="string")event={...event,model};
  return event;
}

export function parseSseData(event:string):string[] { return event.split(/\r?\n/).filter(line=>line.startsWith("data:")).map(line=>line.slice(5).trim()); }
