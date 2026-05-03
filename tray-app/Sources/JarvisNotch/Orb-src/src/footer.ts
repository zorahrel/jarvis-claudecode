import type { AgentFooter } from "./types";

/**
 * Match the trailing footer the router appends:
 *
 *   [t 8.4s = llm 5.8s | tok 41.5k>208 | notch/claude-haiku-4-5-20251001]
 *
 * Returns parsed values + the cleaned text (footer stripped) for display.
 */
const FOOTER_RE = /\n\n\[t\s+([\d.]+)s\s*=\s*llm\s+([\d.]+)s[^\]]*\|\s*tok\s+([\d.]+[kKmM]?)\s*>\s*([\d.]+[kKmM]?)\s*\|\s*([^\]/]+)\/([^\]/]+)\]\s*$/;

export function parseFooter(text: string): { clean: string; footer: AgentFooter | null } {
  const m = text.match(FOOTER_RE);
  if (!m) return { clean: text, footer: null };
  const [full, total, llm, tokenIn, tokenOut, agent, model] = m;
  const footer: AgentFooter = {
    total: parseFloat(total),
    llm: parseFloat(llm),
    tokenIn,
    tokenOut,
    agent: agent.trim(),
    // Strip date suffix from claude-XXX-YYYYMMDDD model names for display.
    model: model.trim().replace(/-\d{8,}$/, "").replace(/^claude-/, ""),
  };
  return { clean: text.slice(0, text.length - full.length).trim(), footer };
}
