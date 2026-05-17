# terminal-bridge

VS Code extension that registers 7 terminal tools for Copilot Chat, executing
commands directly in WSL/Linux via `child_process.spawn`. No MCP server dependency.

Patches VS Code's ext host and workbench bundles to enable native terminal card
rendering — the same confirmation card, command display, and output viewport
that the built-in `RunInTerminalTool` uses.

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

## How it works

### Execution

All tools use `child_process.spawn` to run bash commands:
- **Windows**: spawns `wsl bash -c "..."` 
