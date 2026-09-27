export interface Job {
  tenantId: string;
  idempotencyKey: string;
  attemptId: string;
  amount: number;
}

export interface JobReceipt {
  logicalJobId: string;
  attemptId: string;
  applied: boolean;
  balance: number;
}

export class JobLedger {
  #balances = new Map<string, number>();
  #attempts = new Set<string>();

  process(job: Job): JobReceipt {
    if (!job.tenantId || !job.idempotencyKey || !job.attemptId
      || !Number.isSafeInteger(job.amount) || job.amount < 1) throw new Error('invalid_job');
    const logicalJobId = JSON.stringify([job.tenantId, job.idempotencyKey]);
    const alreadyApplied = this.#attempts.has(job.attemptId);
    if (!alreadyApplied) {
      this.#attempts.add(job.attemptId);
      this.#balances.set(job.tenantId, this.balance(job.tenantId) + job.amount);
    }
    return { logicalJobId, attemptId: job.attemptId, applied: !alreadyApplied,
      balance: this.balance(job.tenantId) };
  }

  balance(tenantId: string): number { return this.#balances.get(tenantId) ?? 0; }
}
