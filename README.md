# terminal-bridge

VS Code extension that registers 7 terminal tools for Copilot Chat, executing
commands via pluggable transport profiles — local bash, WSL, or SSH remotes.
No MCP server dependency.

Patches VS Code's ext host and workbench bundles at activation to enable native
terminal card rendering with streaming output — the same command display,
syntax highlighting, and xterm output viewport that the built-in
`RunInTerminalTool` uses.

## Tools

| Tool | Reference | Description |
|------|-----------|-------------|
| `terminal_fg_run` | `#run` | Run a command synchronously, return stdout+stderr and exit code |
| `terminal_bg_launch` | `#launch` | Launch a background command via tmux, return job ID |
| `terminal_bg_status` | `#status` | Check background job status |
| `terminal_bg_get_output` | `#output` | Get background job output log (tail N lines) |
| `terminal_bg_send_cmd` | `#send` | Send a command to an interactive tmux session |
| `terminal_bg_exit` | `#stop` | Terminate a background job |
| `terminal_bg_list_jobs` | `#list` | List background jobs with optional filters |

## Profiles

Configure named profiles in settings:

```jsonc
"terminal-bridge.profiles": {
  "local": { "type": "local" },
  "wsl-ubuntu": { "type": "wsl", "distribution": "Ubuntu" },
  "dev-box": { "type": "ssh", "host": "dev.example.com", "user": "me" }
},
"terminal-bridge.activeProfile": "local"
```

| Type | Transport | Notes |
|------|-----------|-------|
| `local` | `bash <tmpfile>` | Direct execution on Linux |
| `wsl` | `wsl [-d distro] bash <tmpfile>` | Windows → WSL |
| `ssh` | `ssh host bash -s` via stdin | ControlMaster for connection reuse |

Switch profiles via the status bar item or **Terminal Bridge: Switch Profile**
command. When no profiles are configured, auto-detects WSL on Windows or local
bash on Linux.

SSH profiles use `ControlMaster=auto` with `ControlPersist=10m` for connection
reuse. On Windows, SSH routes through WSL so `~/.ssh/config` and keys from WSL
are used. Requires key-based auth (no interactive password prompts).

## How it works

### Execution

Commands execute via `child_process.spawn` through the active transport:

- **LocalTransport** — spawns `bash` with a temp script file
- **WslTransport** — spawns `wsl bash` with a temp script (Windows path → WSL path)
- **SshTransport** — spawns `ssh host bash -s` with script piped via stdin

Background tools (`bg_*`) use tmux sessions on the target host for persistence.

### Terminal card rendering

VS Code's built-in terminal tool uses internal `toolSpecificData` with
`kind: "terminal"` to trigger a dedicated rendering path (command card with
syntax highlighting + xterm output widget). This path is not exposed to
extension-registered tools by default.

The extension patches two VS Code bundles at activation to bridge this gap:

| # | Target | Patch | Purpose |
|---|--------|-------|---------|
| EH1 | ext host | Forward `toolSpecificData` from `prepareInvocation` | Gets `kind:"terminal"` across the IPC boundary |
| EH2 | ext host | Forward `toolSpecificData` from `progress.report` | Streams output data during execution |
| WB1 | workbench | Merge `toolMetadata` from result after invoke | Final output + exit code on the card |
| WB2 | workbench | Merge `toolSpecificData` in `acceptProgress` | Updates card data during execution |
| WB3 | workbench | Re-render existing snapshot mirror (`setOutput` + `render`) | Live output update without recreating the mirror |
| WB4 | workbench | Poll `_updateTerminalContent` every 500ms | Drives snapshot re-render when no live terminal |
| WB5 | workbench | Reset xterm buffer (ESC c) before re-render | Prevents output duplication on re-render |
| WB6 | workbench | Remove initial-skip in collapsible expand observer | Auto-expands output view during execution |
| — | product.json | Add `toolProgress` to `extensionEnabledApiProposals` | Enables the proposed progress API |

Patches are versioned (`/*terminal-bridge-patched-vN*/`) and auto-restore from
backup on version mismatch. A VS Code restart is required after first
activation to load the patched bundles.

### Rendering behavior

During execution:

1. Terminal card auto-expands with the command in a syntax-highlighted code
   block (shellscript language).
2. Output streams progressively — each `progress.report` sends accumulated
   stdout via `toolSpecificData.terminalCommandOutput`, which the 500ms poll
   picks up and re-renders in the xterm snapshot mirror.
3. A "Running" spinner label shows the last output line.

After completion:

4. The card auto-collapses to a single-line summary ("Ran `<command>`").
5. Expanding the card reveals the full output in a dark terminal widget with
   the final exit code and duration.

## Build

```bash
npm install
node esbuild.mjs          # bundle to dist/extension.js
npm run typecheck          # tsc --noEmit
```

## Package

```bash
npx @vscode/vsce package --no-dependencies
```

Produces `terminal-bridge-<version>.vsix`.

## Install

```bash
code-insiders --install-extension terminal-bridge-<version>.vsix --force
```

After install, restart VS Code. The extension activates on startup, patches the
bundles, and prompts for a second restart to load them.
