import { getAdminSession } from "@/lib/auth/admin";
import { getConfigurationStatus,getProviderCredentials,providers } from "@/lib/env";
import { getDb } from "@/lib/db";
import { readJson,sameOrigin } from "@/lib/http";
export const runtime="nodejs";
export async function GET(){
  if(!await getAdminSession())return Response.json({error:"unauthorized"},{status:401});
  const status=getConfigurationStatus(),credentials=getProviderCredentials(),db=await getDb();
  return Response.json(await Promise.all(status.providers.map(async p=>({...p,configured:p.slots.filter(s=>s.configured).length,slots:await Promise.all(p.slots.map(async s=>{const c=credentials.find(c=>c.provider===p.id&&c.slot===s.slot);const h=c?await db.collection<any>("credential_health").findOne({provider:p.id,fingerprint:c.fingerprint}):null;return{...s,health:h?.authStatus||"unknown",paused:h?.paused===true,lastSuccessAt:h?.lastSuccessAt||null}}))}))));
}
export async function POST(request:Request){
  if(!await getAdminSession())return Response.json({error:"unauthorized"},{status:401});
  if(!sameOrigin(request))return Response.json({error:"cross_origin_request"},{status:403});
  try{const x=await readJson(request) as any;const c=getProviderCredentials().find(v=>v.provider===x.provider&&v.slot===Number(x.slot));if(!c)return Response.json({error:"credential_not_found"},{status:404});const db=await getDb(),q={provider:c.provider,fingerprint:c.fingerprint};
    if(x.action==="pause"||x.action==="resume"){await db.collection("credential_health").updateOne(q,{$set:{paused:x.action==="pause",updatedAt:new Date()}},{upsert:true});return Response.json({ok:true})}
    if(x.action==="retest"){const conf=providers.find(p=>p.id===c.provider)!;const r=await fetch(`${conf.baseUrl}/models`,{headers:{authorization:`Bearer ${c.secret}`},signal:AbortSignal.timeout(10000),cache:"no-store"});await db.collection("credential_health").updateOne(q,{$set:{authStatus:r.ok?"healthy":r.status===401?"invalid":"unknown",lastRetestAt:new Date(),lastErrorStatus:r.ok?null:r.status}},{upsert:true});return Response.json({ok:r.ok,status:r.ok?"healthy":r.status===401?"invalid":"error"},{status:r.ok?200:502})}
    return Response.json({error:"invalid_action"},{status:400});
  }catch{return Response.json({error:"operation_failed"},{status:400})}
}
