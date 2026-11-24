---
description: 围绕在模型周围、将其变成智能体的一切：工具、System prompt、上下文窗口管理、权限控制与钩子。
---

围绕在[模型](./模型（Model）.md)周围、将其变成[智能体](./Agent（智能体）.md)（Agent）的一切：[工具](./工具（Tool）.md)、[System prompt](./System%20prompt（系统提示词）.md)（系统提示词）、[上下文窗口管理](./上下文窗口（Context%20window）.md)、权限控制以及钩子（hooks）。**Claude.ai** 和 **Claude Code** 运行在同一个模型上，但表现截然不同，原因就在于它们的 Harness（驾驭框架 / 调度壳）不同。

模型自身只做一件事：接收文本，生成文本。它既不能读文件、运行命令，也记不住上一个[轮次](./轮次（Turn）.md)。所有这些能力都由 Harness 提供。它负责为每一次[模型提供商请求](./模型提供商请求（Model%20provider%20request）.md)组装[上下文](./上下文（Context）.md)，执行模型发起的[工具调用](./工具调用（Tool%20call）.md)，把[工具返回结果](./工具返回结果（Tool%20result）.md)喂回模型，保存[会话](./会话（Session）.md)历史，在执行高风险操作前向你请求权限，并决定何时进行[上下文压缩](./上下文压缩（Compaction）.md)。Agent 循环——模型提出方案、Harness 执行操作、如此往复——正是由 Harness 驱动的。

这一点对排查问题至关重要。当两个产品的表现出现差异，或者今天的表现和昨天不一样时，变量往往不是模型——而是 Harness。不同的 System prompt、不同的工具集、调整过的默认权限，或是新的上下文管理策略，都会在不改动模型的情况下改变最终行为。这也意味着你的大多数配置都发生在 Harness 层：[AGENTS.md](./AGENTS.md.md) 文件、权限设置和钩子，全都是写给 Harness 的指令，而不是写给模型的。

常见示例：Claude Code、Cursor、Codex CLI——以及 Claude.ai（它是一个对话型 Harness，而不是编程型 Harness）。

_用法示例：_

“同一个模型，为什么 Claude Code 能直接改文件，而 Claude.ai 只能回答问题？”

“Harness 不同——Claude Code 配备了[文件系统](./文件系统（Filesystem）.md)工具、不同的 System prompt 和权限层。这里起决定作用的变量不是模型。”
