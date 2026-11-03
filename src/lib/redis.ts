import { Redis } from "@upstash/redis";
import { env } from "@/lib/env";
let instance: Redis | null = null;
export function getRedis() {
  if (!env.redisUrl || !env.redisToken) throw new Error("Upstash Redis is not configured");
  instance ??= new Redis({ url: env.redisUrl, token: env.redisToken, automaticDeserialization: false });
  return instance;
}
function coordinationKeys(scopes:string[]) {
  return ["fr:v1:leases:global", ...scopes.filter(s=>s.startsWith("client:")).map(s=>`fr:v1:leases:${s}`), ...scopes.filter(s=>s.startsWith("provider:")).map(s=>`fr:v1:leases:${s}`)];
}
export async function checkAdmission(scopes: string[], leaseId: string) {
  const redis=getRedis();const rateKeys=scopes.map(s=>`fr:v1:rate:${s}`);const leaseKeys=coordinationKeys(scopes);const keys=[...rateKeys,...leaseKeys];
  const script=`
local now=tonumber(ARGV[1]);local lease=ARGV[2];local rn=tonumber(ARGV[3]);local cn=#KEYS-rn
for i=1,rn do redis.call('ZREMRANGEBYSCORE',KEYS[i],'-inf',now-60000);if redis.call('ZCARD',KEYS[i])>=tonumber(ARGV[i+3]) then return {0,60} end end
local limits={8,3,1}
for i=rn+1,#KEYS do redis.call('ZREMRANGEBYSCORE',KEYS[i],'-inf',now);if redis.call('ZCARD',KEYS[i])>=limits[i-rn] then return {0,2} end end
for i=1,rn do redis.call('ZADD',KEYS[i],now,lease);redis.call('EXPIRE',KEYS[i],120) end
for i=rn+1,#KEYS do redis.call('ZADD',KEYS[i],now+330000,lease);redis.call('EXPIRE',KEYS[i],360) end
return {1,0}`;
  const limits=scopes.map(s=>s==="global"?"60":s.startsWith("client:")?"30":"5");
  const result=await redis.eval(script,keys,[String(Date.now()),leaseId,String(rateKeys.length),...limits]) as number[];
  return {allowed:Number(result[0])===1,retryAfter:Number(result[1]||1)};
}
export async function releaseAdmission(scopes:string[],leaseId:string){const redis=getRedis();await Promise.all(coordinationKeys(scopes).map(k=>redis.zrem(k,leaseId)));}
export async function useDailyBudget(id:string,limit:number){return useDailyBudgets([{id,limit}]);}
export async function useDailyBudgets(scopes:Array<{id:string;limit:number}>){const redis=getRedis();const day=new Date().toISOString().slice(0,10);const keys=scopes.map(s=>`fr:v1:jev:daily:${day}:${s.id}`);const script="local values={};for i=1,#KEYS do local n=tonumber(redis.call('GET',KEYS[i]) or '0');if n>=tonumber(ARGV[i]) then return 0 end end;for i=1,#KEYS do local n=redis.call('INCR',KEYS[i]);if n==1 then redis.call('EXPIRE',KEYS[i],172800) end end;return 1";return Number(await redis.eval(script,keys,scopes.map(s=>String(s.limit))))===1;}
/** Atomically claim one sign-in attempt against the per-source and shared windows. */
export async function beginLoginAttempt(ip:string){
  const script="local per=tonumber(redis.call('GET',KEYS[1]) or '0');local all=tonumber(redis.call('GET',KEYS[2]) or '0');if per>=tonumber(ARGV[1]) or all>=tonumber(ARGV[2]) then return 0 end;per=redis.call('INCR',KEYS[1]);if per==1 then redis.call('EXPIRE',KEYS[1],900) end;all=redis.call('INCR',KEYS[2]);if all==1 then redis.call('EXPIRE',KEYS[2],900) end;return 1";
  return Number(await getRedis().eval(script,[`fr:v1:login:${ip}`,"fr:v1:login:global"],[5,50]))===1;
}
/** Clear the per-source window after a successful sign-in; the shared window expires on its own. */
export async function clearLoginFailures(ip:string){await getRedis().del(`fr:v1:login:${ip}`);}
