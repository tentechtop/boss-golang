# AI 求职 Copilot 启动与使用说明

本文档说明本地服务、浏览器扩展和自动投递流程的启动与使用方法。运行环境以 Windows PowerShell 为准。

## 1. 环境要求

- 已安装 Go，并且 `go` 命令可在 PowerShell 中使用。
- 已安装 Microsoft Edge。
- 当前工作目录为项目根目录：`F:\workSpace2029\boss`。
- 默认服务端口为 `127.0.0.1:8083`。

## 2. 启动本地服务

在 PowerShell 中进入项目根目录：

```powershell
cd F:\workSpace2029\boss
```

启动后端服务：

```powershell
go run ./cmd/server
```

启动成功后，浏览器打开：

```text
http://127.0.0.1:8083
```

健康检查地址：

```text
http://127.0.0.1:8083/api/health
```

正常响应中应包含：

```json
{"status":"ok"}
```

## 3. 使用其他端口启动

如果 `8083` 被占用，可以临时改端口：

```powershell
$env:APP_ADDR="127.0.0.1:8090"
go run ./cmd/server
```

注意：浏览器扩展和专用 Edge 默认优先使用 `http://127.0.0.1:8083`。为了减少桥接问题，建议日常使用继续保持 `8083`。

## 4. 可选 AI 配置

未配置 DeepSeek Key 时，系统会使用本地规则生成结果。

如需启用 DeepSeek：

```powershell
$env:DEEPSEEK_API_KEY="你的 DeepSeek Key"
go run ./cmd/server
```

可选环境变量：

```powershell
$env:DEEPSEEK_BASE_URL="https://api.deepseek.com"
$env:DEEPSEEK_MODEL="deepseek-chat"
$env:APP_DATA_DIR="data"
$env:APP_STATIC_DIR="web"
```

## 5. 启动专用 Edge 并加载扩展

服务启动后，推荐在系统页面顶部点击：

```text
点击即安装（含启动）
```

该按钮会让后端执行内置启动命令，打开专用 Edge，并加载项目内的 `extension` 扩展目录。

也可以手动执行：

```powershell
.\scripts\start-edge-with-copilot.ps1
```

如果需要关闭旧 Edge 并强制重新加载扩展，可执行：

```powershell
.\scripts\start-default-edge-with-copilot.ps1
```

专用 Edge 会同时打开：

- 系统页面：`http://127.0.0.1:8083`
- BOSS 岗位页面：`https://www.zhipin.com/web/geek/jobs`

## 6. 首次使用流程

1. 打开系统页面：`http://127.0.0.1:8083`。
2. 在“开始自动投递”区域填写目标岗位、目标城市和薪资范围。
3. 如系统里还没有简历，展开“首次使用时补充简历”，粘贴完整简历文本。
4. 点击“开始自动求职”。
5. 系统会保存配置，并唤起专用 Edge 自动化。
6. 扩展连接成功后，系统会自动扫描岗位、生成开场白、发送开场白，并继续处理下一个岗位。

## 7. 自动投递规则

当前自动模式的行为：

- 持续扫描 BOSS 岗位列表。
- 将符合条件的岗位加入投递队列。
- 为岗位生成开场白。
- 打开岗位沟通页并发送开场白。
- 开场白处理完成后，不等待 HR 回复，继续推进下一个岗位。
- 如果岗位缺少链接、无法进入沟通页、疑似猎头或开场白生成失败，会跳过当前岗位并继续下一个。

## 8. 查看运行状态

系统首页右侧会展示：

- 岗位库数量。
- 待处理队列数量。
- 已自动投递数量。
- 当前自动状态。
- 当前正在处理的岗位。
- 投递队列预览。

后端日志会输出到当前 PowerShell 窗口。如果通过后台方式启动，也可能写入：

```text
server.out.log
server.err.log
```

## 9. 停止服务

如果服务是在当前 PowerShell 窗口中用 `go run ./cmd/server` 启动的，按：

```text
Ctrl + C
```

如果需要查看并停止占用 `8083` 的进程：

```powershell
Get-NetTCPConnection -LocalPort 8083 -State Listen
```

拿到 `OwningProcess` 后停止进程：

```powershell
Stop-Process -Id 进程ID -Force
```

## 10. 常见问题

### 页面提示缺少扩展连接

先确认本地服务正在运行，然后点击系统页面顶部的：

```text
点击即安装（含启动）
```

如果仍未连接，手动执行：

```powershell
.\scripts\start-edge-with-copilot.ps1
```

### 端口被占用

查看占用进程：

```powershell
Get-NetTCPConnection -LocalPort 8083 -State Listen
```

停止旧进程后重新启动服务。

### 修改扩展代码后没有生效

扩展内容脚本可能仍在旧 Edge 进程中运行。执行：

```powershell
.\scripts\start-default-edge-with-copilot.ps1
```

该脚本会关闭旧 Edge 并重新加载扩展。

### 自动投递一直不推进

检查以下状态：

- 系统页面是否显示扩展已连接。
- BOSS 是否已登录。
- 投递队列是否还有“已准备”或“待准备”的岗位。
- 当前岗位是否被跳过或已投递。
- `server.err.log` 是否存在错误信息。

## 11. 数据位置

默认数据文件：

```text
data\app-data.json
```

如需更换数据目录：

```powershell
$env:APP_DATA_DIR="data-test"
go run ./cmd/server
```
