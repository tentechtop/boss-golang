# 自动求职启动与使用说明

## 当前默认策略

- 岗位关键词：`golang后端`
- 城市：`深圳市`
- 薪资：`25-35K`
- 自动模式：默认开启
- 扫描范围：自动滚动 BOSS 职位列表，尽量捞取更多岗位
- 投递行为：符合条件的岗位会自动进入沟通页并发送开场招呼

`golang后端` 是首次使用的默认值；可在页面“目标岗位”中改为 `区块链` 等关键词，后续扫描、筛选和自动投递都会使用当前填写值。

## 启动本地服务

在项目根目录执行：

```powershell
go build -o server.exe ./cmd/server
.\server.exe
```

启动后打开：

```text
http://127.0.0.1:8083/
```

## 启动带插件的浏览器

在项目根目录执行：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scripts\start-default-edge-with-copilot.ps1
```

看到类似输出表示扩展已加载：

```text
Edge loaded AI Job Copilot extension: F:\workSpace2029\boss\extension
```

## 使用方法

1. 确认已登录 BOSS 直聘。
2. 打开 `http://127.0.0.1:8083/`。
3. 系统会默认按 `golang后端 + 深圳市 + 25-35K` 自动搜索。
4. 系统会自动滚动职位列表、筛选岗位、生成开场白、进入沟通页并投递。
5. 不需要一直等待 HR 回复，发出首条沟通后会继续处理下一个岗位。

## 查看运行状态

浏览器页面会显示：

- 岗位库数量
- 待处理队列
- 已自动投递数量
- 当前自动状态

也可以用接口查看：

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:8083/api/automation/status'
```

## 停止自动投递

在系统页面点击停止自动投递，或调用接口关闭：

```powershell
$payload = @{ enabled = $false } | ConvertTo-Json -Compress
$bytes = [System.Text.Encoding]::UTF8.GetBytes($payload)
Invoke-RestMethod -Uri 'http://127.0.0.1:8083/api/automation/control' -Method Post -ContentType 'application/json; charset=utf-8' -Body $bytes
```

## 注意事项

- 真实投递前必须确认 BOSS 账号已登录。
- 系统只会使用当前账号和已有简历信息，不应伪造工作经历。
- BOSS 页面结构变化可能导致点击或输入框识别失败，状态页出现错误时需要重新加载扩展。
- 如果 PowerShell 传中文参数，必须用 UTF-8 字节提交，避免出现 `????`。
