export function checkCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error("Action cancelled");
}

/** Abort even if a provider ignores its signal; always consume its late rejection. */
export async function cancellable<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  let listener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    listener = () => reject(new Error("Action cancelled"));
    if (signal?.aborted) listener();
    else signal?.addEventListener("abort", listener, { once: true });
  });
  try { return await Promise.race([work, aborted]); }
  finally { if (listener) signal?.removeEventListener("abort", listener); }
}
