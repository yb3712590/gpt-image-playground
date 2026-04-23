# GPT Image Playground

一个极简的 `gpt-image-2` 试用页。

特性很少，目标是直接可跑：

- 单进程 Node 服务
- 部署目录读取 `config.json`
- 首次可从本机 `.codex` 生成 `config.json`
- 全局 FIFO 队列
- 并发数可配置
- 每个 IP 的限流次数和窗口可配置
- 浏览器会话隔离，用户只能看到自己的任务
- 页面显示队列总数（包含等待中和处理中）
- 5 个 GPT 风格尺寸标签，映射到当前支持的实际尺寸
- 提交后显示估算等待进度条和已等待秒数

## 目录

- `server.js`: 后端服务、队列、限流、会话隔离、图片请求
- `public/index.html`: 页面结构和样式
- `public/app.js`: 前端提交、轮询、状态更新
- `scripts/bootstrap-config.js`: 从 `~/.codex` 生成 `config.json`
- `config.example.json`: 配置样例

## 配置

运行时读取项目根目录的 `config.json`。

字段如下：

```json
{
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-...",
  "host": "0.0.0.0",
  "port": 7654,
  "concurrency": 2,
  "rateLimitMax": 3,
  "rateLimitWindowMinutes": 10
}
```

说明：

- `baseUrl`: 图片接口基地址，服务会请求 `${baseUrl}/images/generations`
- `apiKey`: Bearer token
- `host`: 监听地址，默认 `0.0.0.0`
- `port`: 本地监听端口，默认 `7654`
- `concurrency`: 最大并行生成数
- `rateLimitMax`: 每个 IP 在窗口内允许的请求次数
- `rateLimitWindowMinutes`: 限流窗口，单位分钟

## 尺寸选项

前端显示 3 个唯一真实请求尺寸：

- `Square` -> `1024x1024`
- `Portrait` -> `1024x1536`
- `Landscape` -> `1536x1024`

后端为兼容旧请求仍接受以下别名映射：

- `square` -> `1024x1024`
- `portrait` -> `1024x1536`
- `story` -> `1024x1536`
- `landscape` -> `1536x1024`
- `widescreen` -> `1536x1024`

说明：

- `story` 和 `widescreen` 是重复映射，前端不再展示
- 白边问题优先通过“让请求尺寸更接近构图方向”解决

## 使用方法

### 1. 安装依赖

```bash
npm install
```

### 2. 生成本地配置

如果你本机已经有 `.codex/auth.json` 和 `.codex/config.toml`：

```bash
npm run bootstrap-config -- --force
```

这会在当前目录生成 `config.json`，默认端口为 `7654`。

如果你不想从 `.codex` 生成，也可以手动复制一份样例：

```bash
cp config.example.json config.json
```

然后自行填写 `baseUrl` 和 `apiKey`。

### 3. 启动服务

```bash
npm start
```

默认会监听：

```text
http://127.0.0.1:7654
```

### 4. 打开页面

浏览器访问：

```text
http://127.0.0.1:7654
```

## 页面行为

- 输入提示词后提交
- 提交后文本框和按钮会锁定
- 页面轮询当前任务状态
- 用户只能查看自己这个浏览器会话提交的任务
- 页面会显示队列总数，其中包含等待中的任务和正在处理的任务
- 提交后会显示估算型等待进度条和已等待秒数
- 成功后直接展示图片
- 失败后显示错误，并恢复输入

## 测试

```bash
npm test
```

当前测试覆盖：

- `.codex` 到 `config.json` 的引导
- 配置校验和默认端口
- 配置校验和默认监听地址
- 队列和并发行为
- 队列总数包含 `running`
- 尺寸标签到上游请求尺寸的映射
- 会话隔离
- IP 限流
- 失败释放 worker 槽位
- 前端提交后锁定、尺寸参数发送、进度条更新和失败恢复
