import { getDb } from "@/lib/db";
import { getRedis } from "@/lib/redis";
export const runtime="nodejs";
export async function GET(){const checks=await Promise.allSettled([(async()=>{const db=await getDb();await db.command({ping:1});return true})(),(async()=>{await getRedis().ping();return true})()]);const mongo=checks[0].status==="fulfilled",redis=checks[1].status==="fulfilled",ready=mongo&&redis;return Response.json({status:ready?"ready":"degraded",dependencies:{mongo:mongo?"ready":"unavailable",redis:redis?"ready":"unavailable"}},{status:ready?200:503,headers:{"cache-control":"no-store"}})}
