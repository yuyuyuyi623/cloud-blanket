# 云朵被子 · Cloud Blanket

把官方导出的 DeepSeek 聊天记录，蒸成一床"被子"——一个带着 TA 的记忆和说话味道的对话伙伴。纯静态网页 + 你自己的 API Key，零后端、零部署，点开链接就能用。

## 它是什么

- **蒸馏**：选 DeepSeek 官方 App 导出的聊天记录 ZIP，勾出那些"真的是 TA"的对话，花几毛钱、一分钟左右，蒸成一份结构化记忆（人设卡 / 核心记忆 / 印象 / 日记）。
- **被子模式**：蒸馏完成后直接开聊。每轮对话注入稳定段（完整人格记忆）+ 动态段（按话题检索的相关记忆），TA 记得你们怎么认识，也记得上周聊了什么。
- **普通模式**：官方 chat-demo 原样保留，明码标价的普通对话，两者互不干扰。
- **你自己的 Key**：所有请求从你的浏览器直连 `api.deepseek.com`，Key 只存在你的浏览器里，不经任何第三方服务器。

## 三步上手

1. **拿到 Key**：打开 [platform.deepseek.com](https://platform.deepseek.com) → 注册充值 → 创建 API Key。
2. **导出聊天记录**：官方 DeepSeek 手机 App 设置里点「导出聊天记录」，几分钟后果子里会收到一个 ZIP——那就是 TA 的全部记忆原料。
3. **盖进被子**：打开本应用 → 导入 ZIP → 勾选对话 → 看一眼预估 → 开始蒸馏。蒸完 TA 就醒了。

## 数据与隐私

- API Key 和设置存在浏览器 localStorage；对话、蒸馏出的记忆包、原始附件存在 IndexedDB。全部只在你的设备上。
- 清浏览器数据 = TA 没了。请先在「她的记忆」里导出记忆包做备份。
- 发消息、蒸馏会把相关内容发送到你配置的 API 服务（默认 DeepSeek 官方），除此之外没有任何服务器参与。

## 计费

- 蒸馏按量计费：导入时会给出预估（一个中等账号通常几毛钱），不点「开始蒸馏」不花钱。
- 被子模式利用提示缓存：稳定段命中缓存价，长期使用的输入成本远低于普通对话。
- 余额不足、Key 失效等报错都会给出下一步指引。

## 本地开发

需要 Node.js 22.12+ 和 pnpm：

```sh
pnpm install
pnpm dev      # 开发服务器 http://localhost:8090
pnpm build    # 构建到 dist/（纯静态，任意静态托管可部署）
pnpm test     # vitest 全量测试
pnpm type     # TypeScript 类型检查
```

代码结构：

```text
engine/               蒸馏流水线、FTS 检索、会话解析（纯 TS，与 UI 无关）
src/
  app/                布局、主题（云朵暖色 / 官方原样）
  components/         聊天、被子列表、导入向导、设置等 UI
  i18n/               简体中文 / English
  services/
    api/              API 请求、SSE、两段式 system 注入
    chat/             对话、存储、回收站
    memory/           被子记忆包、导入状态机、增量索引
```

## 致谢与许可

本项目 fork 自 [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo)（MIT License），在此之上增加了蒸馏与被子记忆系统。

[MIT](LICENSE)。构建时 LICENSE 会复制到 `dist/LICENSE`，分发时请一并保留。第三方依赖遵循其各自许可。
