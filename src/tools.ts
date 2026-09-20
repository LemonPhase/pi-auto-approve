import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

type AnyTool = ToolDefinition<any, any, any>;
type ExecuteArgs = Parameters<AnyTool["execute"]>;
type Result = ReturnType<AnyTool["execute"]>;

/** Preserve the full Pi definition and all execution arguments around a policy check. */
export function wrapTool<T extends AnyTool>(delegate: T, around: (args: ExecuteArgs, next: () => Result) => Result): T {
  return { ...delegate, execute: (...args: ExecuteArgs) => around(args, () => delegate.execute(...args)) };
}
