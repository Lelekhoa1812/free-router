import { timingSafeEqual } from "node:crypto";
import { env } from "@/lib/env";
import { getDb } from "@/lib/db";
export const runtime="nodejs";export const maxDuration=60;
export async function GET(request:Request){
  const supplied=request.headers.get("authorization")?.replace(/^Bearer\s+/i,"")||"",expected=env.cronSecret||"";const a=Buffer.from(supplied),b=Buffer.from(expected);if(!expected||a.length!==b.length||!timingSafeEqual(a,b))return Response.json({error:"unauthorized"},{status:401});
  const db=await getDb(),now=new Date(),names=["responses","debug_payloads","tool_metadata","metrics","audit_events","probe_results","requests"],deleted:Record<string,number>={},end=Date.now()+2000;
  for(const name of names){if(Date.now()>end)break;try{const c=db.collection(name),docs=await c.find({expiresAt:{$lte:now}},{projection:{_id:1}}).limit(200).toArray();const r=docs.length?await c.deleteMany({_id:{$in:docs.map(d=>d._id)}}):{deletedCount:0};deleted[name]=r.deletedCount}catch{deleted[name]=0}}
  return Response.json({ok:true,deleted,ranAt:now.toISOString()});
}
