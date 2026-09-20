import type { Action, ApprovalProvider, Decision, UserChoice } from "./types.js";
import { cancellable, checkCancelled } from "./cancellation.js";

export class ApprovalUnavailable extends Error {}

interface Job { start(): void; cancel(): void }
export class ApprovalQueue {
  private running = false;
  private pending: Job[] = [];

  request(provider: ApprovalProvider, action: Action, decision: Decision, maxPending: number, signal?: AbortSignal): Promise<UserChoice> {
    checkCancelled(signal);
    if (this.pending.length + Number(this.running) >= maxPending) return Promise.reject(new ApprovalUnavailable("Approval queue is full"));
    return new Promise<UserChoice>((resolve, reject) => {
      let started = false;
      const onAbort = () => job.cancel();
      const cleanup = () => signal?.removeEventListener("abort", onAbort);
      const job: Job = {
        cancel: () => {
          if (started) return; // Active dialogs receive the abort signal directly.
          this.pending = this.pending.filter(item => item !== job);
          cleanup();
          reject(new Error("Action cancelled"));
        },
        start: () => {
          started = true;
          this.running = true;
          void (async () => {
            try {
              checkCancelled(signal);
              const choice = await cancellable(provider.request(action, decision, signal), signal);
              checkCancelled(signal);
              resolve(choice === "allow_once" ? choice : "reject");
            } catch (error) { reject(error); }
            finally { cleanup(); this.running = false; this.next(); }
          })();
        },
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.pending.push(job);
      this.next();
    });
  }
  private next(): void { if (!this.running) this.pending.shift()?.start(); }
}
