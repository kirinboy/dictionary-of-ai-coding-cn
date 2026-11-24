---
description: 由 Harness 装配了工具、System prompt 和上下文窗口，并与用户交替推进轮次的模型——即处于运行状态中的模型。
---

由 [Harness](./Harness（驾驭框架）.md) 装配了[工具](./工具（Tool）.md)、[System prompt（系统提示词）](./System%20prompt（系统提示词）.md)和[上下文窗口](./上下文窗口（Context%20window）.md)，并与用户交替推进[轮次](./轮次（Turn）.md)的[模型](./模型（Model）.md)。_Claude Code 是一个 Agent。Cursor 是一个 Agent。Claude.ai 也是一个 Agent。_ Agent 是你真正对话的对象——它是为了特定目的而配置好的、处于运行状态中的模型。

与本词典中的大多数术语不同，“Agent”并不指代某个具体的机械部件。模型是一份[参数](./参数（Parameters）.md)文件；Harness 是你可以直接指出来的软件代码。Agent 两者都不是——它是你正在与之交流的那个整体单元。人们总是习惯将 [AI](./AI（人工智能）.md) 拟人化，而 Agent 正是那个被拟人化的对象：你把任务委托给它，它读取你的消息并作出回应，它也是“它又把构建搞挂了”这句话里的那个“它”。当你说 Agent 做了某件事时，实际上是“模型加 Harness”一起完成了这件事，但你会把这个组合当作单一的行为主体来沟通。

这个概念比这一波 AI 浪潮要古老得多。软件智能体（software agent）——即你为其设定目标、由它代你行事的程序——从 AI 诞生之初就一直存在。

_避免使用：_ “the AI”、“the bot”（过于笼统——模糊了你指的究竟是底层参数，还是经过 Harness 封装的运行实体）。

_用法示例：_

“你这次迁移用的是哪个 Agent？”

“本地用 Claude Code，写 UI 用 Cursor——底层是同一个模型，只是 Harness 不同。”
