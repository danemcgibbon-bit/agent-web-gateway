"use client";

import { useState } from "react";

type CheckStatus = "detected" | "possible" | "no_signal" | "disabled" | "unable_to_check";
type CheckResult = {
  status: CheckStatus;
  confidence?: string;
  requested_url?: string | null;
  final_url?: string | null;
  evidence?: string[];
  error_code?: string;
  verification?: {
    directory?: {
      status?: "verified" | "not_indexed" | "unavailable" | "skipped";
      tool_count?: number;
      tools?: Array<{ name?: string; description?: string; kind?: string | null; impl?: string | null; page?: string | null }>;
      api_surface?: string | null;
      pages?: string[];
      matching_tool_count?: number;
      other_tool_pages?: string[];
    };
  };
};

const GATEWAY_URL = "https://agent-web-gateway.djrookie99.chatgpt.site/";

const stateCopy: Record<CheckStatus, { title: string; body: string }> = {
  detected: { title: "WebMCP detected", body: "This page exposes a concrete WebMCP registration signal. Prefer the site’s native tools when your agent can use them." },
  possible: { title: "Possible WebMCP", body: "The page contains WebMCP-related runtime code, but this static check could not prove a registered tool." },
  no_signal: { title: "This site may not be agent-ready yet", body: "That’s exactly what Agent Web Gateway is for. It gives your AI agent another way to access this website when native agent support isn’t available." },
  disabled: { title: "WebMCP disabled on this page", body: "The response’s Permissions-Policy disables tools for this page. Try the compatibility gateway instead." },
  unable_to_check: { title: "Unable to check", body: "The site could not be checked safely or within the time limit. No WebMCP claim was made." },
};

function displayUrl(value: string): string {
  const trimmed = value.trim();
  return trimmed.includes("://") ? trimmed : `https://${trimmed}`;
}

function promptTarget(result: CheckResult): string | null {
  for (const candidate of [result.final_url, result.requested_url]) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    try {
      const target = new URL(candidate);
      if (target.protocol !== "https:" || target.username || target.password) continue;
      target.hash = "";
      return target.toString();
    } catch {
      continue;
    }
  }
  return null;
}

export default function WebMcpChecker() {
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<CheckResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  async function check(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (loading || !url.trim()) return;
    setLoading(true);
    setResult(null);
    setCopyState("idle");
    try {
      const response = await fetch("/api/webmcp-check", {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ url: displayUrl(url) }),
      });
      const payload: unknown = await response.json();
      if (payload && typeof payload === "object") setResult(payload as CheckResult);
      else setResult({ status: "unable_to_check" });
    } catch {
      setResult({ status: "unable_to_check" });
    } finally {
      setLoading(false);
    }
  }

  function retryCheck() {
    if (loading || !url.trim()) return;
    void check({ preventDefault: () => undefined } as React.FormEvent<HTMLFormElement>);
  }

  async function copyStarter() {
    if (!result) return;
    const target = promptTarget(result);
    if (!target) return;
    const text = `Use ${GATEWAY_URL} to help you access ${target} more naturally. I’ll tell you what I want to do.`;
    try {
      await navigator.clipboard.writeText(text);
      setCopyState("copied");
      window.setTimeout(() => setCopyState("idle"), 2000);
    } catch {
      setCopyState("failed");
    }
  }

  const copy = result ? stateCopy[result.status] : null;
  const directory = result?.verification?.directory;
  const directoryTools = directory?.status === "verified" && Array.isArray(directory.tools) ? directory.tools.filter((tool) => typeof tool?.name === "string" && tool.name.trim()) : [];
  const target = result && (result.status === "no_signal" || result.status === "unable_to_check") ? promptTarget(result) : null;
  const agentPrompt = target ? `Use ${GATEWAY_URL} to help you access ${target} more naturally. I’ll tell you what I want to do.` : null;
  return (
    <section className="webmcp-checker" aria-labelledby="webmcp-checker-title" aria-busy={loading}>
      <div className="webmcp-checker-copy">
        <p className="section-label">WebMCP checker</p>
        <h2 id="webmcp-checker-title">Does your favorite website use WebMCP?</h2>
        <p>Paste a URL to check whether it works natively with AI agents. If it doesn’t yet, we can help make it accessible to them.</p>
      </div>
      <form className="webmcp-checker-form" onSubmit={check}>
        <label className="webmcp-search-label" htmlFor="webmcp-checker-url">Search a public website</label>
        <div className={`webmcp-search-shell${loading ? " is-loading" : ""}`}>
          <span className="webmcp-search-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" focusable="false"><circle cx="10.8" cy="10.8" r="6.4" /><path d="m16 16 4.5 4.5" /></svg>
          </span>
          <input id="webmcp-checker-url" name="url" type="text" inputMode="url" autoComplete="url" placeholder="Search a website or paste its URL" value={url} onChange={(event) => setUrl(event.target.value)} disabled={loading} />
          <span className="webmcp-search-key" aria-hidden="true">Enter</span>
          <button className="button button-primary webmcp-search-submit" type="submit" disabled={loading || !url.trim()}>
            <span>{loading ? "Checking…" : "Check site"}</span>
            {loading ? <span className="webmcp-search-spinner" aria-hidden="true" /> : <span aria-hidden="true">↗</span>}
          </button>
        </div>
        <p className="webmcp-search-caption">Press Enter to check · powered by the WebMCP.com API</p>
      </form>
      {copy && result ? result.status === "no_signal" ? (
        <div className="webmcp-checker-result result-no_signal webmcp-no-signal-result" role="status" aria-live="polite">
          <div className="webmcp-result-heading"><span className="webmcp-result-dot" aria-hidden="true" /><h3>This site may not be agent-ready yet</h3></div>
          <div className="webmcp-no-signal-message">
            <p className="webmcp-no-signal-lead">That’s exactly what Agent Web Gateway is for.</p>
            <p>It gives your AI agent another way to access this website when native agent support isn’t available.</p>
          </div>
          {agentPrompt ? (
            <div className="webmcp-prompt-card">
              <p className="webmcp-prompt-label">Your agent prompt</p>
              <p className="webmcp-prompt-text">{agentPrompt}</p>
              <div className="webmcp-prompt-actions">
                <button className="button button-primary webmcp-prompt-button" type="button" onClick={copyStarter}>
                  <span>{copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy unavailable" : "Copy prompt for my agent"}</span>
                  <span aria-hidden="true">{copyState === "copied" ? "✓" : "↗"}</span>
                </button>
                <span className="webmcp-visually-hidden" aria-live="polite">{copyState === "copied" ? "Prompt copied. Paste it into your AI assistant." : copyState === "failed" ? "Copy unavailable. Please select the prompt text manually." : ""}</span>
              </div>
              <p className="webmcp-prompt-helper">Paste this into your AI assistant. From there, just tell it what you want to do.</p>
            </div>
          ) : null}
          <details className="webmcp-technical-details">
            <summary>Why “may not”?</summary>
            <p>We didn’t find confirmed native agent support in this check. Some sites may expose it dynamically.</p>
            {result.evidence?.length ? <ul>{result.evidence.map((item) => <li key={item}>{item}</li>)}</ul> : null}
          </details>
        </div>
      ) : result.status === "unable_to_check" ? (
        <div className="webmcp-checker-result result-unable_to_check webmcp-no-signal-result webmcp-unable-result" role="status" aria-live="polite">
          <div className="webmcp-result-heading"><span className="webmcp-result-dot" aria-hidden="true" /><h3>We couldn’t check this site</h3></div>
          <div className="webmcp-no-signal-message"><p>We weren’t able to confirm whether it already works directly with AI agents. You can still try using it with Agent Web Gateway.</p></div>
          {agentPrompt ? <div className="webmcp-prompt-card"><p className="webmcp-prompt-label">Your agent prompt</p><p className="webmcp-prompt-text">{agentPrompt}</p><div className="webmcp-prompt-actions"><button className="button button-primary webmcp-prompt-button" type="button" onClick={copyStarter}><span>{copyState === "copied" ? "Copied" : copyState === "failed" ? "Copy unavailable" : "Copy prompt for my agent"}</span><span aria-hidden="true">{copyState === "copied" ? "✓" : "↗"}</span></button><span className="webmcp-visually-hidden" aria-live="polite">{copyState === "copied" ? "Prompt copied. Paste it into your AI assistant." : ""}</span></div><p className="webmcp-prompt-helper">Paste this into your AI assistant. From there, just tell it what you want to do.</p></div> : null}
          <button className="webmcp-retry-button" type="button" onClick={retryCheck} disabled={loading}>Try checking again</button>
          <details className="webmcp-technical-details"><summary>Technical details</summary><p>The site could not be safely inspected or did not respond within the checking limit, so we cannot make a reliable claim about its WebMCP support.</p></details>
        </div>
      ) : (
        <div className={`webmcp-checker-result result-${result.status}`} role="status" aria-live="polite">
          <div className="webmcp-result-heading"><span className="webmcp-result-dot" aria-hidden="true" /><h3>{copy.title}</h3>{result.confidence ? <span className="webmcp-confidence">{result.confidence} confidence</span> : null}</div>
          <p>{copy.body}</p>
          {result.evidence?.length ? <ul>{result.evidence.map((item) => <li key={item}>{item}</li>)}</ul> : null}
          {directory?.status === "verified" ? (
            <div className="webmcp-directory-detail">
              <div className="webmcp-directory-facts">
                <span>Gateway catalog match</span>
                {typeof directory.tool_count === "number" ? <span>{directory.tool_count} cataloged tool{directory.tool_count === 1 ? "" : "s"}</span> : null}
                {directory.api_surface ? <span>{directory.api_surface} API surface</span> : null}
                {typeof directory.matching_tool_count === "number" && directory.other_tool_pages?.length ? <span>{directory.matching_tool_count} on this path</span> : null}
              </div>
              {directoryTools.length ? (
                <details className="webmcp-tool-list">
                  <summary>View tools in our catalog</summary>
                  <ul>
                    {directoryTools.slice(0, 5).map((tool) => <li key={`${tool.name}-${tool.page ?? "root"}`}><code>{tool.name}</code>{tool.page ? <span>{tool.page}</span> : null}</li>)}
                  </ul>
                  {directoryTools.length > 5 ? <p>Showing the first five of {directoryTools.length} cataloged tools.</p> : null}
                </details>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
