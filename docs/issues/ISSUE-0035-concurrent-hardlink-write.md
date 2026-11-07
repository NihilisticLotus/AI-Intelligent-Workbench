# ISSUE-0035：文件共享锁不能阻止校验后的并发硬链接

| 项 | 值 |
|---|---|
| 状态 | investigating |
| 类型 | 安全边界 |
| 严重程度 | 高 |
| 发现于 | [独立文件工具内部验收](../acceptance/step-1.3.md) |
| 开启 | 2026-11-08 |
| 关闭 | |

## 现象

Windows 文件用只允许读取共享的句柄打开且已核对单链接后，另一个进程仍能创建指向同一文件的新硬链接。随后原位写入会同步改变工作区之外的新别名。单纯改成不共享也不能阻止本机测试中的链接创建。

## 复现步骤

1. 只在自行创建的临时目录中建立 project / private，创建 project/file.txt；工作区外的别名也限定在此临时目录内。
2. 载入实际 file-guard.cs，建立实际 AicFileGuard 并保持根句柄；通过测试反射调用实际私有 Open，以已有文件写入参数打开目标、通过当前单链接校验。
3. 持有返回的文件句柄，通知测试父进程；父 Node 进程执行 linkSync，将别名建立在 project 外。
4. 通过原文件句柄写入 changed，确认项目文件及外部别名均改变。这里人为暂停校验到写入间隔，只为确定竞态成立，未修改生产宿主添加故障开关。

## 影响

当前文件工具可以拒绝打开时已经存在的多硬链接，却不能据此保证恶意并发进程在操作期间无法新增别名。因此原位写入不能宣称工作区外无副作用。独立运行时仍为 false，文件 driver 没有 REST / 正式任务入口；本次仅临时夹具受影响，无真实项目、凭据或模型调用。

## 根因

单链接数量是检查时刻的状态，Windows 共享模式的写入 / 删除约束不能当作硬链接创建的完整互斥。最终摘要检查也无法检测校验后新增的同 inode 别名。

## 处理方式

在正式开放文件写入前继续验证可覆盖命名空间变更的方案，例如具备明确中断 / 确认语义的 oplock，或能同时保留审批冲突校验的替换机制；必须用实际并发夹具证明，而不能只追加一次链接计数检查或取消所有测试。当前不开放独立运行时、不宣称完整文件隔离，规格 / 设计 / 验收同步记录边界。

## 验证

两个本机 FileStream 试验分别以 FileShare.Read 和 None 保持句柄时，Node 都成功创建新链接；实际生产 Open 句柄的反射夹具进一步确认 outsideAliasChanged=true。所有夹具在已校验的临时目录中创建并清理，脚本只位于忽略目录；没有使用用户文件。修复与阻断并发链接的自动回归尚未完成。

## 时间线

- 2026-11-08 开启：独立文本工具接入审查中复现共享模式不能阻止并发硬链接；进一步使用实际 file-guard.cs 的 Open 与根句柄重现外部临时别名同步改变。正式运行时继续关闭，修复前不按完整文件保护验收。
- 2026-11-08 内部文件工具与限制记录提交 `f31d466`，全量 477 项默认测试通过、3 跳过，类型检查 / 构建通过；这些正常 / 错误处理验证没有修复本单反例，状态保持 investigating，正式文件写入仍未开放。
- 2026-11-08 按用户授权派一路只读研究补核官方契约，尚未选定可靠替代。[IRP_MJ_SET_INFORMATION](https://learn.microsoft.com/en-us/windows-hardware/drivers/ifs/irp-mj-set-information2) 的硬链接 oplock 说明限定覆盖既有目标链接的情形；[MS-FSA 新增链接算法](https://learn.microsoft.com/en-us/openspecs/windows_protocols/ms-fsa/891bb8eb-89f8-46ca-80b7-9f5d4e8b5583) 未提供源文件新增任意别名必定阻塞的充分契约。因此 RWH / RH 只是研究候选，不能据此关单；本轮未实现或实测 oplock。
- 2026-11-08 [IRP_MJ_CREATE](https://learn.microsoft.com/en-us/windows-hardware/drivers/ifs/irp-mj-create2) 说明仅属性 / 同步权限的打开不打断 oplock，[FILE_LINK_INFORMATION](https://learn.microsoft.com/en-us/windows-hardware/drivers/ddi/ntifs/ns-ntifs-_file_link_information) 说明设置该信息不要求特定访问权限。后续并发回归必须覆盖预开 / 新开的低权限原生句柄与 NtSetInformationFile，不能仅凭 Node 包装调用一次被阻塞就宣布保护完整。以上是文档核查，不冒充本机原生低权限句柄实测。
- 2026-11-08 [FSCTL_REQUEST_OPLOCK](https://learn.microsoft.com/en-us/windows/win32/api/winioctl/ni-winioctl-fsctl_request_oplock) 要求重叠句柄与异步生命周期；[CancelIoEx](https://learn.microsoft.com/en-us/windows/win32/api/ioapiset/nf-ioapiset-cancelioex) 本身不等待请求完成。后续若选用必须验证申请失败即拒绝、事件 / 内存收尾与对端解除阻塞。替换文件也须保留审批后目标身份 / 摘要的冲突检查，尚未证明可靠的比较交换，当前不采用未经验证的快速补丁。
