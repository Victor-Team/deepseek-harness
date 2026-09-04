---
description: "面向用户与维护者的进程外 omp subagent 后端，用于委派给 oh-my-pi 子代理、选择其模型或排查远程子运行。"
kind: "package-reference"
---

# @deepseek-ai/dsh-subagent-omp

[English](README.md) | 中文

## 概述

`dsh-subagent-omp` 把每次委派的子代理作为一个全新的 [omp](https://github.com/can1357/oh-my-pi)（oh-my-pi）进程运行，并通过 omp 的换行分隔 RPC 协议驱动它。子代理自带运行时、工具、skills 与模型路由，因此一次委派可以触达该 omp 安装已认证的任意提供方——包括订阅制路由——而 harness 无需持有那些凭据。每次运行会 spawn 一个进程、等待 omp 的 `ready` 帧、发送一次 prompt、等待终态轮次，并通过共享的 subagent 结果约定返回子代理的最终答案。父级只收到该答案或一条安全错误；omp 的推理、工具活动与 stderr 绝不跨越边界。当子代理应该是一个真正的 omp 会话、使用 omp 自己的模型目录、并与父 harness 完全隔离时，选择它。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [开发备注](#dev-note)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)

-----

<a id="use-this-package"></a>
## 使用本包

当一份组合需要一个由 omp 模型路由支撑的隔离子代理时，挂载本提供方。路径是显式的：挂载 seam、挂载本提供方，并通过委派工具行把它暴露给模型。

### 何时选择它

当子代理应当运行在父级 provider 路由所不提供的模型之下，或者任务需要的正是 omp 自己的工具与 skills 时，选 omp 而不选进程内后端。若子代理必须共享父级的工具注册表、人格组合或会话血缘，则应改用进程内后端——本提供方这三者都不共享。

子代理的模型目录取决于被 spawn 的那个 omp 安装解析出什么，而这又取决于该安装自身的配置与认证。指名了 omp 无法解析的模型的提供方行会在运行时失败，而不是加载时。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `providerName` | `omp` | `ctx.subagents` 上的非空注册名称；每个已挂载实例都需要唯一值 |
| `command` | `omp` | omp 可执行文件；非绝对路径时经宿主 `PATH` 解析 |
| `args` | `[]` | 置于本包固定 RPC 模式标志之前的参数 |
| `cwd` | 父会话 cwd | 工作目录覆盖；相对值在加载时相对 harness 启动目录解析 |
| `model` | omp 自身选择 | 作为 `--model` 传入的模型 id；省略时保留 omp 配置的角色模型与 profile 默认值 |
| `env` | `{}` | 叠加在已清除凭据的父环境之上的显式子进程环境 |
| `disposeEofGraceMs` | `6000` | stdin EOF 之后、进程树终止开始之前的宽限 |
| `disposeGraceMs` | `3000` | 进程树各终止层级之间的宽限 |

每次运行都会追加 `--mode rpc --no-session`。RPC 模式选定本提供方所讲的协议；`--no-session` 让子代理保持临时性，因此一次性委派不会在磁盘上留下可恢复的 omp 会话。

`command` 刻意默认为裸 `omp` 而非绝对路径：由哪个安装来应答是部署决策，而一个固定了 profile 或模型的包装脚本是合理选择。但请注意，这类包装脚本同时会**收窄模型目录**——profile 别名只能看到该 profile 配置过的提供方。

```yaml
- id: subagent-omp
  name: '@deepseek-ai/dsh-subagent-omp'
  config:
    providerName: omp
    model: anthropic/claude-opus-5
- id: tool-subagent-omp
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: omp
    toolName: subagent_omp
    backgroundMode: one-shot
    maxDepth: provider-managed
```

### 你会得到什么

前台调用会把 omp 的最终 assistant 文本交给模型；运行失败时返回停止原因与可选的安全诊断。后台调用先返回 Job id，随后通用作业控制面通过 `job_output` 公开同一个最终答案。

### 失败与恢复

`command` 缺失或无法启动、子代理在 `ready` 帧之前退出、以及轮次途中流关闭，都会以一条安全消息使运行失败；进程树会在拒绝浮现之前被拆除。完成轮次却没有产出文本的子代理会判为错误，而不是空的成功。取消结算为 `aborted`。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

### 设计承诺

- **每次运行一个全新进程。** 没有池化、没有会话复用、没有恢复。一个 omp 进程恰好服务一次委派任务，并随之拆除。
- **omp 的配置是权威。** 提供方只覆盖 `--model` 与固定的 RPC 标志。模型目录、认证、工具、skills 以及其余所有产品设置都保持该 omp 安装的原生状态。
- **只讲协议版本 1。** omp 声明 `supportedProtocolVersions: [1, 2]` 并默认为 1。版本 2 为超出传输上限的帧引入 `rpc_chunk` 分片，而一次只返回最终答案的运行并不需要它。客户端遇到分片帧会拒绝而不是重组半个帧，因此未来若默认值变更，会明确报错而不是截断答案。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：config schema、提供方注册 |
| [`src/rpc.ts`](src/rpc.ts) | omp RPC 客户端：帧处理、命令关联、终态轮次判定 |
| [`src/run.ts`](src/run.ts) | 运行生命周期：spawn、握手、发布、拆卸梯队 |

### 运行流程

一次启动只接受文本块，将它们拼接成 omp 的单个 `prompt` 字符串，并根据父会话确定子级 cwd。它经子进程 seam spawn，在子进程 stdio 之上构造 RPC 客户端，并且**仅在** omp 的 `ready` 帧到达之后才发布运行——因此 fulfillment 意味着子进程已存活并开始讲协议。已发布的结果发送一次 `prompt` 命令，等待终态轮次，然后用 `get_last_assistant_text` 读取答案。

**`agent_end` 并不总是终态。** 当某个 `agent_end` 所属会话已经排定了自动续跑（自动重试、空停止重试）时，omp 会在其上设置 `willContinue: true`；omp 自己的协议文档写明订阅方不得把它当作终态。因此客户端会继续等待不带该标志的 `agent_end`。若把第一个当作终态，那么只要 omp 发生重试，就会返回一个只完成一半的答案。

拆卸沿用与兄弟进程外后端相同的协作式梯队：stdin EOF 给 omp 留出刷新与回收后代进程的窗口，随后由 `terminate()` 掌管 SIGTERM → 宽限 → SIGKILL 的升级及其整棵进程树的退出证明。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [Subagent 子系统](../../../docs/subsystems/subagent.zh.md)——服务约定、提供方约定与终态结果语义。
- [dsh-subagent seam](../subagent/README.zh.md)——本提供方注册于其上的注册表与启动 API。
- [ACP subagent 提供方](../subagent-acp/README.zh.md)——面向讲 ACP 的子代理的兄弟进程外后端。
- [生成配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-subagent-omp)——每个受支持配置字段及其源声明。

-----

<a id="dev-note"></a>
## 开发备注

omp RPC 协议不是 JSON-RPC，因此本包并不共用 Codex 后端所使用的传输层。它的客户端刻意保持最小：只对 `ready`、`response`、`agent_end` 与 `rpc_chunk` 作出反应，忽略其余所有事件帧，因为一次性委派只需要终态轮次与最终答案。要拓宽它——用于流式投影、宿主工具或可续子代理——是一次设计变更而非增量变更，应当与消费那些帧的 seam 工作放在一起。

-----

<a id="model-experience"></a>
## 模型体验

### 子级请求

#### 模型看到什么

omp 子级会在一个全新的临时会话中，以单次 prompt 接收拼接后的文本任务。它的工作区是父会话 cwd；所选提供方实例会固定已配置的模型与环境，而省略的模型及其余所有产品设置来自该 omp 安装自身的配置。子级拥有的是 omp 的工具与 skills，不是 harness 的。

#### Token 影响

子级需为独立的 omp 上下文和轮次承担 token 成本。子级 token 不会进入父级上下文。

#### KV Cache 影响

与父级请求缓存相互独立。能否复用只取决于 omp 自身的模型、指令、工具和全新会话。

### 父级调度与结果（间接）

#### 模型看到什么

通过 `dsh-tool-subagent`，前台调用会让父级模型看到 omp 的最终 assistant 文本，或一条带停止原因与安全诊断的错误。后台调用先返回 Job id；随后通用作业控制面会送达完成通知，并通过 `job_output` 公开同一个答案。omp 的推理、工具活动、中间消息、stderr 与工作区差异不会复制进父会话。

#### Token 影响

前台输入按保留的最终答案或错误增长。后台输入还包含启动确认、完成通知以及后续作业结果。本提供方自身不向父级添加任何工具 schema。

#### KV Cache 影响

仅追加：前台在可复用的父级前缀之后添加一条结果，后台则追加确认、通知与后续控制结果。它们都不会改写更早的前缀。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **没有可选的共享能力**——对于本提供方，共享服务会拒绝 `agentOptions`、输出 schema、子任务角色设定、工具筛选和 harness 深度强制约束。omp 提供 `--append-system-prompt`，它本可承载角色设定，但该参数接受的是文件路径而非内联文本，目前没有任何运行会写出这样一个文件。
- **每个连接只允许一次 prompt**——客户端会拒绝同一条线路上的第二次并发 prompt。这与它所服务的一次性委派相符；omp 的 `steer`、`follow_up` 与可续会话命令都未接线。
- **只支持协议 v1**——大于 omp 单帧传输上限的答案会失败，而不会重组 v2 分片帧。
- **子代理的触达范围属于那个安装，而非 harness**——一次委派能用哪些模型、是否有任何订阅提供方处于已认证状态，都是被 spawn 的那个 omp 安装的属性。harness 既不检查也不管理该状态，因此期望使用订阅制路由模型的部署必须自行确保该安装已登录。
- **没有按实际经过时间触发的超时或副作用回滚**——长时间运行的工作由调用方取消，且取消前已更改的文件或外部系统不会恢复原状。
