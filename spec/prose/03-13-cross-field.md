`resource.operation` determines the required `resource.type`, `usage` and `cost`
sub-objects. These constraints are enforced by the schema's root `allOf`.

| Operation class | resource.type | usage | cost |
| --- | --- | --- | --- |
| Model operations (`generation`, `embedding`, `reranking`) | `model` | `usage.llm` present; `usage.tool` absent | `cost.llm` MAY be present; `cost.tool` absent |
| Tool operations (`tool_execution`, `retrieval`) | `tool` | `usage.tool` present; `usage.llm` absent | `cost.tool` MAY be present; `cost.llm` absent |

`resource.namespace` is permitted only on tool operations.
