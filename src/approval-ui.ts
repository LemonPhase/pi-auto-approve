import type { ApprovalProvider } from "./types.js";
import { checkCancelled } from "./cancellation.js";

interface ApprovalUI {
  select(title: string, options: string[], settings?: { signal?: AbortSignal }): Promise<string | undefined>;
}

/** Escape control and directional-format characters, including those JSON leaves literal. */
export function displayJSON(value: unknown): string {
  return JSON.stringify(value, null, 2).replace(/[\u007f-\u009f\u2028-\u202e\u2066-\u2069]/g,
    char => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

export function createApprovalProvider(ui: ApprovalUI, promptTimeoutMs: number): ApprovalProvider {
  return { request: async (action, decision, signal) => {
    const full = displayJSON(action.args);
    const summary = action.tool === "bash" ? full
      : displayJSON({ path: action.args.path, contentCharacters: typeof action.args.content === "string" ? action.args.content.length : undefined,
        edits: Array.isArray(action.args.edits) ? action.args.edits.length : undefined });
    const preview = summary.length > 700 ? `${summary.slice(0, 700)}\n[Preview only; inspect full arguments below]` : summary;
    const title = ["Pi Auto Approve", `Tool: ${action.tool}`, `Directory: ${displayJSON(action.cwd)}`, preview,
      `Reason: ${displayJSON(decision.reason)}`,
      decision.classifier ? `Approve probability: ${decision.classifier.approveProbability}` : "",
      !action.userContext ? "No user context available." : action.contextTruncated ? "User context was truncated." : ""].filter(Boolean).join("\n");
    // One overall deadline spans the whole flow: the initial prompt and every inspect page.
    const deadline = Date.now() + promptTimeoutMs;
    const ask = async (prompt: string, options: string[]): Promise<string | undefined> => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("Approval prompt timed out");
      let timer: ReturnType<typeof setTimeout> | undefined;
      const expired = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Approval prompt timed out")), remaining);
      });
      try { return await Promise.race([ui.select(prompt, options, { signal }), expired]); }
      finally { if (timer) clearTimeout(timer); }
    };
    while (true) {
      checkCancelled(signal);
      const choice = await ask(title, ["Allow once", "Reject", "Inspect full arguments"]);
      checkCancelled(signal);
      if (choice !== "Inspect full arguments") return choice === "Allow once" ? "allow_once" : "reject";
      // Bounded pages make large commands and file payloads inspectable in both TUI and RPC.
      const characters = Array.from(full);
      const pages: string[] = [];
      for (let i = 0; i < characters.length; i += 600) pages.push(characters.slice(i, i + 600).join(""));
      let page = 0;
      while (true) {
        checkCancelled(signal);
        const choices = [ ...(page > 0 ? ["Previous page"] : []), ...(page + 1 < pages.length ? ["Next page"] : []), "Back to approval" ];
        const selected = await ask(`Full arguments — page ${page + 1}/${pages.length}\n${pages[page]}`, choices);
        checkCancelled(signal);
        if (selected === "Next page" && page + 1 < pages.length) page++;
        else if (selected === "Previous page" && page > 0) page--;
        else break;
      }
    }
  } };
}
