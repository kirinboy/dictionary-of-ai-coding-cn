---
description: 任何为推理提供模型服务的实体。通常是远程服务（Anthropic、OpenAI、Google），也可以是本地运行（Ollama、llama.cpp）。
---

任何为[推理](./推理（Inference）.md)提供[模型](./模型（Model）.md)服务的实体。通常是远程服务（Anthropic、OpenAI、Google），但也可以是本地部署——例如在你自己的机器上运行 Ollama、LM Studio 或 llama.cpp。[Harness](./Harness（驾驭框架）.md) 自己并不直接运行模型，而是向提供商发起请求。

提供商掌握着底层基础设施：[参数](./参数（Parameters）.md)存放在它的硬件上，每一次[模型提供商请求](./模型提供商请求（Model%20provider%20request）.md)都是 Harness 通过网络发送 [Token](./Token（词元）.md) 并取回预测结果的过程。这使得提供商成为一整类问题的源头，而这些问题常常被误归咎于模型或 Harness——速率限制、算力降级和服务中断全都发生在这里。当 [Agent](./Agent（智能体）.md) 在[会话](./会话（Session）.md)中途卡住，或者每个[轮次](./轮次（Turn）.md)都报错时，最先值得查看的就是提供商的状态页。

提供商还决定了商业条款：[输入](./输入%20Token（Input%20tokens）.md)与[输出 Token](./输出%20Token（Output%20tokens）.md) 的单价、[前缀缓存](./前缀缓存（Prefix%20cache）.md)折扣，以及究竟有哪些模型可用。需要注意，提供商和模型的研发方可以是不同的公司——例如 Bedrock、Vertex 和 OpenRouter 都在托管并提供其他公司训练的模型。

本地提供商是用能力换取控制权：能塞进你自家硬件的模型远小于前沿大模型，但没有任何数据会离开你的机器，也没有按 Token 计费的账单。

_用法示例：_

“我们能为那个物理隔离的客户离线运行这套系统吗？”

“把模型提供商换成本地部署的就行——在他们的机器上跑 Ollama 或 llama.cpp。Harness 不在乎后台是谁，它只是换个端点发请求而已。”
