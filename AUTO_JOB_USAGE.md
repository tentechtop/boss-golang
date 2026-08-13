# 自动求职启动和使用说明

## 启动服务

在项目根目录执行：

```powershell
go run .\cmd\server
```

默认访问地址：

```text
http://127.0.0.1:8083
```

默认数据目录：

```text
data\app-data.json.leveldb
```

首次启动会自动把旧的 `data\app-data.json` 迁移到 LevelDB 本地数据库，后续岗位、队列、反馈都写入 LevelDB，不再依赖浏览器保存大量数据。

## 默认自动求职参数

程序默认按下面条件执行自动模式：

```text
岗位：golang后端
城市：深圳市
薪资：25-35K
```

岗位为首次使用的默认值，可在页面“目标岗位”中改为 `区块链` 等关键词。

进入页面后点击“开始自动求职”，系统会自动搜索岗位、滚动翻页、加入投递队列，并继续推进沟通。

## 浏览器扩展

如果页面提示缺少扩展：

1. 点击页面上的“打开扩展管理页”。
2. 点击“下载扩展安装包”。
3. 在浏览器扩展管理页开启开发者模式。
4. 加载解压后的扩展目录。
5. 回到页面刷新。

浏览器扩展只保存短生命周期命令、最近少量 bridge 结果和当前自动模式状态。岗位数据、投递队列、反馈记录都由服务端 LevelDB 保存，避免触发 `Resource::kQuotaBytes quota exceeded`。

## BOSS 登录态

一键启动会打开专用 Edge，不使用普通 Chrome 或普通 Edge 的登录态。专用 Edge 的用户数据目录固定为：

```text
%LOCALAPPDATA%\BossJobCopilot\EdgeProfile
```

首次使用专用 Edge 时需要扫码登录一次 BOSS。之后只要不删除这个目录，重启服务、重新加载扩展、重新打开专用 Edge 都应继续保留登录态。

如需自定义专用 Edge 登录态目录：

```powershell
$env:BOSS_EDGE_PROFILE_DIR="D:\BossJobCopilot\EdgeProfile"
go run .\cmd\server
```

## 内存和存储限制

服务端默认设置 Go runtime 内存上限为 2G：

```powershell
$env:APP_MEMORY_LIMIT_BYTES="2147483648"
go run .\cmd\server
```

内置存储裁剪规则：

```text
最多保留岗位：2000
最多保留队列项：2000
最多保留反馈：1000
自动化错误日志：最多 20 条
```

如果浏览器再次出现 quota 错误，优先重启服务并刷新页面。服务端数据不会因此丢失，因为核心数据已在 LevelDB 中持久化。
