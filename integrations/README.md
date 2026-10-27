# 通用 CLI / MCP：静态报告优先

默认使用 **liubai_report**，直接调用 Python 生成器，无需本地 HTTP 服务。Node.js 22+ 用于桥接，Python3.10+ 用于扫描。

```powershell
node integrations/cli.mjs report --root 'C:\' --outDir report
node integrations/cli.mjs report --index report/index.json --reportOnly true --outDir report-refreshed
```

返回 report/index 的绝对路径、fileUri、扫描状态和来源。生成后双击 HTML 离线浏览；桥接不会自动打开网页或操作缓存/配置。MCP report 参数为 root、index、outDir、reportOnly、overwrite、measureAllocated；reportOnly=true 必须提供 index，overwrite 仅在明确需要替换输出时设为 true，默认拒绝覆盖已有产物。

WorkBuddy 等支持 stdio MCP 的客户端可合并以下配置。路径改为实际安装位置，不能覆盖已有其他服务器配置。

```json
{"mcpServers":{"liubai-storage":{"command":"node","args":["C:/path/to/c-drive-care-skill/integrations/mcp.mjs"]}}}
```

通用操作约束在 `skills/liubai-storage/SKILL.md`。未在 WorkBuddy/豆包客户端完成实连验收；普通聊天产品是否具备本地工具入口取决于产品，不能把模型支持与宿主能力混为一谈。

MCP 支持 2025-11-25 及此前三个已列协商版本，stdio 只输出 JSON-RPC。没有执行或删除工具。导出内容可能包含个人文件路径，宿主可能向模型服务发送工具结果，请按用户范围使用。

## 可选 V1 兼容模式

原 liubai_status / caches / files / scan / cancel_scan / plan 六个工具仍保留，明确需要 `npm run serve:legacy` 启动本机服务。它们不是静态报告依赖。LIUBAI_URL 仅对这些旧工具生效，只允许本机地址；非法 URL 不阻断 liubai_report。

旧服务计划需要其独立 UI 人工确认。静态 HTML 中的复选框和 JSON 建议不会被服务当作执行凭据。

`measureAllocated=true` 仅适用于显式新扫描，用于按文件身份去重测量分配量；与 reportOnly 不能同时使用，耗时会增加。
