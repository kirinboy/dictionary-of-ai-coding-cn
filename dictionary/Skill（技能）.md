---
description: 打包成独立单元的可传授能力——平时留在上下文窗口之外，直到当前任务通过上下文指针将其拉入。
---

一种打包成独立单元的可传授能力——包含把某一项任务做好的指令与资源，平时存放在[环境](./环境（Environment）.md)中，直到当前任务需要时才通过[上下文指针](./上下文指针（Context%20pointer）.md)拉入[上下文窗口](./上下文窗口（Context%20window）.md)。它是 [Harness](./Harness（驾驭框架）.md) 中实现[渐进式披露](./渐进式披露（Progressive%20disclosure）.md)的基本单元。

Skill 是一项定义在 [agentskills.io](https://agentskills.io) 的开放标准——最初由 Anthropic 提出，现已被大多数主流 Harness 采用，因此编写一次 Skill 就能跨平台使用。其格式为一个包含以下内容的文件夹：

- 一个 `SKILL.md` 文件——包含元数据（至少有名称和描述）以及指令正文
- 可选地，供 [Agent](./Agent（智能体）.md) 运行的脚本
- 可选地，指令中所指向的模板和参考资料

默认情况下，只有名称和描述会留在[上下文](./上下文（Context）.md)中。当 Agent 的任务与之匹配时，才会加载其余内容。在此之前，无论完整指令有多长，Skill 都几乎不占空间——只占一两句话的 [Token](./Token（词元）.md)。

这正是 Skill 与 [AGENTS.md](./AGENTS.md.md) 的区别：AGENTS.md 无论什么任务都会被加载到每一次[会话](./会话（Session）.md)中；而 Skill 只在出现特定类型的工作时才会被读取——例如发版、搭建新服务脚手架、编写数据库迁移——其余时间则会被忽略。

_避免使用：_ “[工具](./工具（Tool）.md)”——工具是 Agent _调用_的；而 Skill 是 Agent _阅读_的指令。

_用法示例：_

“我应该把部署手册放在哪？”

“做成 Skill——只有任务涉及部署时 Agent 才会加载它。如果放进 AGENTS.md，这种每周才用一次的东西就会在每一[轮次](./轮次（Turn）.md)里白白消耗 Token。”
