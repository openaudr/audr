The REQUIRED `resource` object identifies the consumed model or tool and the
operation performed.

A tool identity has up to three levels. `resource.provider` names the vendor or
platform that executes the tool: `self-hosted` for a tool executed by the host
application or a process it launched, otherwise the operator's slug, which the host
supplies for a remote source. `resource.namespace` names the source within that
provider that defines the tool, such as a toolkit, an action group or an MCP server
configuration key. `resource.name` is the bare tool name, unique within the
namespace.
