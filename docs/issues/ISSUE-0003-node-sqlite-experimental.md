# ISSUE-0003：node:sqlite 仍是实验特性

| 项 | 值 |
|---|---|
| 状态 | open |
| 类型 | 技术债 |
| 严重程度 | 低 |
| 发现于 | 第 1.1 步技术选型（plans/phase-1.md 第 3 节） |
| 开启 | 2026-11-06 |
| 关闭 | |

## 现象

Node 24.14 加载 `node:sqlite` 时会打印 `ExperimentalWarning: SQLite is an experimental feature`。

## 影响

接口以后可能变化；启动日志里有一条警告。

## 处理方式

选用它是为了避免在 Windows 上编译原生模块（better-sqlite3 需要编译工具链，对不使用命令行的用户不友好）。数据库访问封装在 Gateway 的 db 模块里，必要时只需替换这一层。打包成单文件可执行程序（桌面阶段）前重新评估。

## 时间线

- 2026-11-06 开启。
