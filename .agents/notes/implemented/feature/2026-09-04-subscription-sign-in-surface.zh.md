# Agent Note: 订阅制登录的配置界面

Status: implemented

[English](2026-09-04-subscription-sign-in-surface.md) | 中文

## 问题

模型选择器只提供那些凭据是"人敲进去的密钥"的路由。一个人已经在付费的订阅计划——Claude Pro/Max、ChatGPT Plus/Pro、GitHub Copilot、Kimi Code、SuperGrok、OpenRouter——够不着，于是要用其中一个就得在 harness 旁边另跑它自己的 CLI 产品，而不是像选别的模型那样选它。

库这一层什么都不缺。`dsh-llm-pi-ai` 早就为每个 pi-ai 目录 provider 注册了登录流程，`dsh-authorization` 也早就定义了什么是流程、并且一次只跑一个尝试。这条缝缺的是一个角色：它有 Service Definition、有 Provider，没有 Consumer，而且没有任何组合挂载过这个服务。那些流程全都存在，全都到不了。

## 决策

`dsh-authorization` 挂进 base bundle，与 `credentials-local` 并列；`dsh-api-settings-controller` 新增 `authorization` Remote namespace，作为这条缝的 Consumer。

一项登录在线上的身份是它的凭据 key，视图另带 key 的 id 段作为 `subject`。模型页知道的是 provider 路由 id 而不是凭据 key；`subject` 正是让它把登录挂到所属那一行上的东西，而 API 包无需知道这个 key 是哪个插件铸的。

一次尝试就是一条流。`start` 产出 `notice` 帧说明要打开什么、`prompt` 帧提出要回答什么，最后恰好一条 `settled` 帧携带 `authorized`、`cancelled` 或 `failed`——这正是这条缝本就为旁观者区分的三态结算，因为不是自己发起尝试的观察者，否则无从分辨"人拒绝了"和"流程坏了"。作答走单发的 `answer(promptId, value)` 而不是在同一条流上回传，从而让载体保持单向。

关闭这条流即撤回尝试，并拒绝每一个仍在等待的问题。挂起的 `prompt()` 是一个跨线持有的 promise；没有这一条，关掉的标签页会让流程永远悬着，还占着注册表为每个 key 只允许的那一个尝试位。

同步的拒绝——注册表没挂载、key 不合法——由 `async` 方法报出，从而以 rejection 的形式抵达调用方。一个在返回 promise 之前就抛出的 `@Remote` 方法，客户端接不住。

## 考虑过的替代方案

**为每个 CLI agent 注册一个 step 驱动器并把它发布成路由。** 否决：那是在一个产品一个产品地重造 pi-ai 目录已经为全部订阅一次性覆盖的东西；而且被驱动的 agent 跑的是那个 CLI 自己的循环，不是 harness 的——那是另一种能力，不是这一种。那部分工作留在原处，但它不是"让我能选这些模型"的答案。

**读取另一个 CLI 已经存好的凭据。** 阅读后否决：omp 把授权放在它自己的 SQLite 库里，dsh 放在自己的凭据文档里。在两个各自会刷新它的库之间搬运一份授权，等于让一个会轮换的令牌有两个写者。

**做一个提交 API 密钥的「登录」按钮。** 否决：设置页本来就在写凭据**引用**，那正是密钥那一半。订阅授权是凭据**记录**，靠对话取得；两半互补，所以密钥框保留，这一套加在它旁边。

**在同一条流上回传作答。** 否决：Remote 流载体是单向的，而为每次尝试再开一条通道，并不比一次带关联 id 的单发调用多买到什么。

## 后果

每一个自带登录的 pi-ai 目录 provider 现在都够得着了：39 条流程，其中 6 条是订阅制 OAuth。

一个人可以从配置界面登录，被授权路由的模型随即像任何别的 provider 一样进入模型目录——这正是订阅模型能被任意 agent、preset 或议会席位选中的前提。

本次改动不含 Client 那一半：还没有按钮能发起一次尝试，因此这个 namespace 目前只有直接调用方够得着。在模型页真正跑起一次登录之前，本次仍是**未接线·不计入交付**。
