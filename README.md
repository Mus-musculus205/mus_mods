# Structured Psyche for SullyOS

Structured Psyche 是面向SullyOS 的源码补丁式插件，为主聊天增加严格的结构化心象输出。

模型在一次响应中分别返回角色真正说出口的正文与没有说出口的即时心象：

```json
{
  "reply": "角色真正说出口的正文",
  "psyche": "角色没有说出口的即时心象"
}
```

`reply` 继续进入 SullyOS 原有聊天处理管线；`psyche` 复用现有心象卡片与消息 metadata，不会混入角色正文。

本包不会新增模型供应商，也不绑定 Gemini、固定模型或固定 API 地址。

## 包内容

```text
structured-psyche/
├─ README.md
├─ LICENSE
├─ structured-psyche.patch
└─ drop-in/
   └─ utils/
      ├─ structuredPsyche.ts
      └─ geminiStructuredPsyche.ts
```

- `structured-psyche.patch`：完整集成补丁，只包含本功能修改及应用补丁所需的少量上下文。
- `LICENSE`：与 SullyOS 上游一致的 PolyForm Noncommercial License 1.0.0，并按顺序保留上游与插件修改者署名。
- `drop-in/utils/structuredPsyche.ts`：供应商无关的 schema、启用判断与严格 parser。
- `drop-in/utils/geminiStructuredPsyche.ts`：早期实验路径的 deprecated 兼容转发层，新代码不应从这里导入。

测试已包含在补丁中，不额外复制第二份测试源码。

## 功能特性

- 每个角色拥有独立的 Structured Psyche 开关，默认关闭。
- 继续复用 SullyOS 原有心象总开关、样式、自定义提示词和展示组件。
- API 地址、模型、API Key 与 streaming 设置全部跟随 SullyOS 全局配置。
- 使用 OpenAI-compatible `response_format.json_schema` 约束 `reply` 与 `psyche`。
- 支持 `safeApi` 已有的普通 JSON 与 SSE 响应归一化。
- transport streaming 保持开启时，不展示尚未完成的 JSON envelope。
- 保留 McD、Luckin、MCP、AMSG2 等现有真实工具调用循环。
- malformed structured response 明确失败，不修 JSON、不回退 native reasoning、不把 JSON 原文显示成气泡。
- 历史心象不会进入下一轮模型上下文。

## 兼容要求

本补丁面向包含现有 Thinking Chain、`safeApi` 与主聊天工具循环的 SullyOS 版本。

不同版本可能存在代码位置差异，请先运行补丁检查并人工审查冲突。发布包不记录开发仓库名称、分支或提交标识。

运行环境沿用 SullyOS 本身的要求，不新增 npm 依赖。

上游模型或中转需要支持：

```text
OpenAI-compatible /chat/completions
response_format.type = json_schema
```

部分兼容接口虽然接受 OpenAI 请求格式，但不支持 Structured Output，启用插件后会返回协议错误。这属于供应商能力边界，不会静默降级成普通回复。

## 安装

将本目录放在 SullyOS 仓库外或仓库内任意临时位置，然后在 SullyOS 仓库根目录执行：

```powershell
git apply --check <插件目录>\structured-psyche.patch
git apply <插件目录>\structured-psyche.patch
```

macOS 或 Linux：

```bash
git apply --check <plugin-directory>/structured-psyche.patch
git apply <plugin-directory>/structured-psyche.patch
```

`--check` 成功后再正式应用。不要直接用裁剪后的 `Chat.tsx`、`useChatAI.ts` 或 `types.ts` 覆盖上游文件。

补丁会修改或新增：

```text
apps/Chat.tsx
components/chat/ThinkingChainSettingsModal.tsx
hooks/useChatAI.ts
types.ts
utils/chatRequestPayload.ts
utils/thinkingChainPrompt.ts
utils/thinkingGate.ts
utils/structuredPsyche.ts
utils/geminiStructuredPsyche.ts
```

以及对应的 focused tests。

## 使用

应用补丁并启动 SullyOS 后：

1. 进入角色聊天。
2. 打开心象设置。
3. 开启原有心象功能。
4. 开启 `Structured Psyche`。

只有两个开关同时开启时，主聊天才会请求结构化心象。关闭独立开关后，原有 native thinking 行为保持不变。

## 实现流程

```text
心象总开关 + Structured Psyche 开关
                    |
                    v
SullyOS 全局 API / 模型 / stream 配置
                    |
                    v
response_format: json_schema
                    |
                    v
safeApi 聚合 JSON、SSE 与真实 tool_calls
                    |
                    v
最终 content 严格解析为 { reply, psyche }
                    |
          +---------+---------+
          |                   |
          v                   v
reply 进入原正文管线     psyche 写入 metadata.thinkingChain
```

`reply` 继续经过 SullyOS 原有的气泡拆分、引用、表情、HTML、卡片、动作与持久化流程。

`psyche` 通过现有 `reasoningContent` override 接入心象展示，不创建平行数据库、独立 renderer 或第二套消息模型。

## 上下文与隐私

心象只保存在 assistant 消息的：

```text
metadata.thinkingChain
```

下一轮模型历史由 `ChatPrompts.buildMessageHistory` 从消息正文 `content` 构造，不会序列化 `metadata.thinkingChain`。

补丁包含 `utils/structuredPsyche.context.test.ts`，验证：

- assistant 正文仍进入历史；
- psyche 内容不进入历史；
- `thinkingChain` 字段名不进入历史。

这里保证的是“不进入下一轮模型聊天上下文”。心象仍会保存在 SullyOS 本地数据库中，用于界面展示；完整数据库备份或包含 metadata 的导出格式可能携带它。

## Streaming 与工具调用

Structured Psyche 不强制关闭底层 streaming。请求仍使用用户的全局 stream 设置，`safeApi` 继续负责识别并归一化 SSE 或普通 JSON。

structured 模式只关闭普通正文与 native reasoning 的实时 UI 预览，防止以下未完成内容出现在气泡中：

```json
{"reply":"尚未完成
```

真实工具 follow-up request 继续从原有 `baseReqBody` 派生，因此保留 `response_format`、tools 与现有 dispatch 逻辑。只有最终不再包含 `tool_calls` 的响应才进入 structured parser。

## 验证

应用补丁后，在 SullyOS 仓库根目录执行：

```powershell
pnpm test:run utils/structuredPsyche.test.ts utils/structuredPsyche.context.test.ts utils/structuredPsyche.wiring.test.ts utils/thinkingChainPrompt.test.ts utils/thinkingGate.test.ts utils/chatRequestPayload.test.ts
pnpm run build
```

发布包生成时的验证结果：

```text
Focused tests: 46 passed
Production build: passed
Patch apply check: passed
```

## 卸载

如果应用补丁后没有继续修改同一批文件，可以在仓库根目录执行：

```powershell
git apply --check --reverse <插件目录>\structured-psyche.patch
git apply --reverse <插件目录>\structured-psyche.patch
```

macOS 或 Linux 使用 `/` 路径分隔符即可。

如果安装后已经继续开发，请不要强制反向应用；应根据 Git diff 手动移除对应 hunks，避免覆盖后续修改。

## 当前边界

- 当前只接入主聊天的本地请求路径。
- Instant Push、proactive 与 worker 生成路径不启用 Structured Psyche。
- legacy 二轮搜索、回忆、日记等内部 LLM 调用保持原有行为。
- schema 要求 `reply` 与 `psyche` 都是非空字符串，协议错误不会自动重试或静默回退。

## License

本插件作为 SullyOS 的修改与衍生集成，沿用上游的 PolyForm Noncommercial License 1.0.0。完整条款见 [`LICENSE`](./LICENSE)。

署名顺序：

```text
Copyright (c) 2024-2026 NMJ (SullyOS / 手抓糯米机)
Structured Psyche modifications Copyright (c) 2026 mus
```

本包仅授权许可证所定义的非商业用途。分发本插件或其修改版本时，必须同时保留完整 LICENSE 与其中所有 `Required Notice:` 行。

## 上游合并说明

这个补丁刻意复用 SullyOS 现有抽象：

- 原有 Thinking Chain prompt 与展示组件；
- 原有 `reasoningContent` override；
- 原有 `safeApi` SSE/JSON 聚合；
- 原有真实工具循环；
- 原有消息后处理与持久化。

没有引入新依赖、Provider Registry、独立工具循环、独立 streaming parser 或新的持久化系统。上游审查时建议重点检查 `hooks/useChatAI.ts` 的启用门控、`utils/structuredPsyche.ts` 的协议边界，以及上下文隔离测试。
