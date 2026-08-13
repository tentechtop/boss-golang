# Boss Job Copilot 无障碍版

## 启动

双击 `BossJobCopilot-Setup-0.3.9.exe`。程序会自动完成以下操作：

1. 安装程序文件到 `%LOCALAPPDATA%\BossJobCopilot`。
2. 启动本地求职服务，最大内存占用限制为 2GB。
3. 打开专用 Microsoft Edge。
4. 自动加载求职扩展并打开系统页面和 BOSS 职位页面。

不需要打开扩展管理页，也不需要手动选择扩展目录。

## 首次使用

1. 在自动打开的专用 Edge 中登录一次 BOSS。
2. 系统默认搜索 `深圳市 / golang后端 / 25-35K`。
3. 登录状态保存在 `%LOCALAPPDATA%\BossJobCopilot\EdgeProfile`，以后启动不需要重复登录。
4. 点击系统页面中的“开始自动求职”即可持续扫描、投递和处理 HR 消息。

## 数据与隐私

- 简历、岗位和投递记录只保存在本机 `%LOCALAPPDATA%\BossJobCopilot\data`。
- 在系统页填写的 DeepSeek API Key 只保存在上述本机数据目录中，设置接口不会回显明文。
- 安装包不包含制作者的 BOSS 登录信息、简历或历史数据库。
- 扩展只加载到产品专用 Edge，不修改日常使用的 Edge 配置。

## 故障排查

启动失败时会出现 Windows 原生错误对话框，读屏软件可以直接读取。详细日志位于：

- `%LOCALAPPDATA%\BossJobCopilot\logs\launcher.log`
- `%LOCALAPPDATA%\BossJobCopilot\logs\service.log`

如果电脑没有 Microsoft Edge，请先安装 Edge 后重新双击产品 EXE。

## 卸载

关闭产品打开的专用 Edge 后，删除 `%LOCALAPPDATA%\BossJobCopilot` 即可。该目录包含登录状态和本地求职数据，删除后无法恢复。
