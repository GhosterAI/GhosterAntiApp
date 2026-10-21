/**
 * Entry point of the compiled desktop program, ghosteranti-sidecar. The same program runs the MCP
 * helper when the small ghosteranti-mcp launcher next to it starts it with MCP_MODE first, so the
 * desktop app ships one Bun runtime instead of two.
 */

// Keep in step with src-tauri/src/bin/ghosteranti-mcp.rs.
export const MCP_MODE = "__mcp";

if (import.meta.main) {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === MCP_MODE) {
    const { runAgentHelper } = await import("./agent/ghosteranti-mcp.ts");
    await runAgentHelper(args);
  } else {
    const { runCli } = await import("./cli.ts");
    runCli();
  }
}
