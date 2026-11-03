export const TWO_INSTANCE_READY_PREFIX = "fr:test:two-instance:ready:";
export const TWO_INSTANCE_RESULT_PREFIX = "fr:test:two-instance:result:";
export const TWO_INSTANCE_ATTEMPTS = 15;

export interface TwoInstanceResult {
  worker: string;
  attempts: number;
  allowed: number;
  denied: number;
  settled: number;
}
