# pi-compact-model

[Pi](https://pi.dev) 的上下文压缩扩展：用你指定的模型和思考等级做压缩，并且让摘要不再越压越大。

## 为什么需要它

Pi 内置的压缩在长会话里会越来越慢，原因有三个：

- 更新摘要时要求保留旧摘要里的全部信息，所以摘要只增不减。
- 会话里读过、改过的所有文件路径每次都重新写进摘要。
- 压缩请求沿用会话当前的思考等级。

一个实际的长会话里，摘要涨到了 22 万字符，其中 82% 是文件路径，每次压缩约 10 分钟，每一两个小时触发一次。

## 它做了什么

- 用配置里指定的模型压缩，思考等级单独设置，不跟随会话。
- 摘要有大小上限，提示词要求合并或删掉已经完成的旧内容。
- 文件清单只保留最近用到的路径。
- 历史放不进所选模型的上下文窗口时，自动分成多次请求滚动摘要。
- 遇到限流或临时错误时退避重试。
- 任何失败都交还 Pi 内置压缩，不会让会话卡在未压缩状态。

## 安装

两种方式选一种。两种都装会把同一个命令注册两次。

作为 Pi 包安装：

```bash
pi install git:github.com/YnSen/pi-compact-model
```

或者直接放进扩展目录：

```bash
git clone https://github.com/YnSen/pi-compact-model ~/.pi/agent/extensions/compact-model
```

装完后在已打开的会话里执行 `/reload`。

## 用法

| 命令 | 作用 |
| --- | --- |
| `/compact-model` | 弹出可用模型列表，选完模型后接着选思考等级 |
| `/compact-model <模型名的一部分>` | 列表只显示名称匹配的模型 |
| `/compact-model <provider/modelId>` | 直接指定模型，思考等级沿用现有设置 |
| `/compact-model thinking` | 只改思考等级，从列表里选 |
| `/compact-model thinking <等级>` | 直接指定思考等级 |
| `/compact-model session` | 压缩时跟随会话当前的模型 |
| `/compact-model status` | 查看当前设置 |
| `/compact-model on` / `off` | 启用，或停用后交还 Pi 内置压缩 |

思考等级列表只列出所选模型支持的档位。配置的等级在某个模型上不存在时，实际使用最接近的一档，确认消息和 `status` 里会写明。

在 Pi Web 里，从斜杠菜单选中命令后需要再按一次回车才会弹出列表：Pi Web 的斜杠菜单只补全命令名，不补全参数。

## 配置

配置文件是 `~/.pi/agent/compact-model.json`，每次压缩时重新读取，改完不用重启。文件不存在或缺少字段时使用默认值。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | `false` 时交还 Pi 内置压缩 |
| `model` | `null` | `"provider/modelId"`；`null` 表示跟随会话当前的模型 |
| `thinkingLevel` | `"off"` | `off` / `minimal` / `low` / `medium` / `high` / `xhigh` / `max` |
| `maxSummaryTokens` | `6000` | 摘要正文的大小上限，不含文件清单 |
| `maxModifiedFiles` | `60` | 保留最近修改过的多少个文件路径 |
| `maxReadFiles` | `20` | 保留最近只读过的多少个文件路径 |
| `retries` | `3` | 限流或临时错误后的重试次数，间隔 2s、4s、8s，最长 30s |

示例：

```json
{
  "model": "your-provider/your-model-id",
  "thinkingLevel": "low",
  "maxSummaryTokens": 8000
}
```

## 需要知道的取舍

- 思考等级越高，压缩越慢。摘要任务一般 `off` 或 `low` 就够。
- 第一次接手一个由 Pi 内置压缩留下的超长摘要时，摘要正文会被压到 `maxSummaryTokens` 以内，较早的细节会丢。觉得丢得太多就调大这个值。
- 工具调用里超过 2000 字符的参数（比如 `write` 写入的整份文件）在送去摘要前会被截断。
- 指定的模型不存在或没有凭据时，提示后改用会话模型压缩。

## 兼容性

在 Pi 1.6.1 和 Pi Web 0.19.0 上开发和测试。
