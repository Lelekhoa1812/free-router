import { getAdminSession } from "@/lib/auth/admin";
import { getDb } from "@/lib/db";
import { getRedis } from "@/lib/redis";
import { getConfigurationStatus } from "@/lib/env";
export const runtime="nodejs";
export async function GET(){if(!await getAdminSession())return Response.json({error:"unauthorized"},{status:401});const [mongo,redis]=await Promise.allSettled([(async()=>{const db=await getDb();await db.command({ping:1});return true})(),(async()=>{await getRedis().ping();return true})()]);return Response.json({configuration:getConfigurationStatus(),checks:{mongo:mongo.status==="fulfilled",redis:redis.status==="fulfilled"},checkedAt:new Date().toISOString()},{headers:{"cache-control":"no-store"}})}
