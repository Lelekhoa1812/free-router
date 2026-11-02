import { getDb } from "@/lib/db";
import { authenticateClient } from "@/lib/auth/client";
import { jsonError } from "@/lib/http";
import { decryptJson } from "@/lib/crypto";
export const runtime="nodejs";
async function owned(request:Request,id:string){const auth=await authenticateClient(request,"responses");if("error" in auth)return {error:jsonError(401,"Invalid API key","invalid_api_key")};const rec=await(await getDb()).collection<any>("responses").findOne({responseId:id,ownerId:String(auth.key._id),expiresAt:{$gt:new Date()}});return rec?{auth,rec}:{error:jsonError(404,"Response is unavailable","response_not_found")};}
export async function GET(request:Request,ctx:{params:Promise<{id:string}>}){const {id}=await ctx.params;const o=await owned(request,id);if("error" in o)return o.error;try{const data=decryptJson<any>(o.rec.payload,`${o.rec.ownerId}:${id}:response:v1:${new Date(o.rec.expiresAt).toISOString()}`);return Response.json(data.response,{headers:{"cache-control":"no-store"}})}catch{return jsonError(404,"Response is unavailable","response_not_found")}}
export async function DELETE(request:Request,ctx:{params:Promise<{id:string}>}){const {id}=await ctx.params;const o=await owned(request,id);if("error" in o)return o.error;await(await getDb()).collection("responses").deleteOne({_id:o.rec._id});return Response.json({id,object:"response.deleted",deleted:true},{headers:{"cache-control":"no-store"}})}
