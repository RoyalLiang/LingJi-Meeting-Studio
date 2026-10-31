# Pi 双平台 Actions 测试包

2026-10-31。Mac ARM64 与 Windows x64 测试包均已产出并通过各自 CI 检查，待真机验收。只推送测试分支 `dev_pi-chain-regression-20261031`，没有改 main、版本标签或 GitHub Release，也没有替换本机已安装程序。

## 下载与来源

需登录 GitHub，解压 Actions ZIP 后使用其中的 `.dmg` 或 `.exe`。附件保留 14 天，实际有效期见[API回执](../evidence/pi-actions-packages-20261031/receipt.json)。

| 平台 | 下载 | ZIP大小 | 二进制构建源码 |
| --- | --- | ---: | --- |
| Mac Apple Silicon，macOS 14.6+ | [Mac测试包](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41205937873/artifacts/13044886750) | 240341575字节，约229MiB | `6e353a88872ea70555f61cae641bc98a48eef193` |
| Windows x64 | [Windows测试包](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41212396795/artifacts/13047649411) | 417608896字节，约398MiB | `871176d393af75c076e99198b89aa27d1bde8f02` |

两端仍显示应用版本 0.2.6。Mac 使用[已通过的 macos 作业](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41205937873/job/124550906229)；该旧 run 的 Windows 后来超时，所以 Windows 使用[优化后成功的 run](https://github.com/RoyalLiang/LingJi-Meeting-Studio/actions/runs/41212396795)。两端不是同一完整 Git 快照；Windows 额外改了打包哈希生成、测试与 CI，应用/前端/后端/原生源码、依赖锁、版本和依赖保持一致，见[共享应用源核对](../evidence/pi-actions-packages-20261031/shared-source-proof.json)。

## 验证

- 本地 Node 26.12.1 全量回归 **809/809**，无跳过；lint 通过，独立审查无未解决 P1/P2。
- Mac CI 的完整回归、类型/Web构建、Rust测试、冻结源码 DMG、Finder布局、签名、独立后端/重启持久化、Pi初始化、包内真实本地ASR、附件上传均通过。
- Windows CI 的真实NSIS前置检查、定点回归、Web/后端准备、Rust测试、冻结源码打包、静默安装/卸载、资源完整性、独立后端/Pi初始化、本地ASR、模型选装、升级与UI探针、附件上传通过。
- Pi包级探针要求 `/api/agent/tasks` 返回200且任务数组有效，能拦住SDK初始化失败；它不等于真实云模型任务或实体音源通过。此前[本地Pi fixture和整链证据](pi-local-packages-2026-10-31.md)另行保留。
- 已通过GitHub API核对两端来源SHA、作业结论、附件名称/字节数/digest/未过期。digest是Actions ZIP封装摘要；内层安装器校验文件随附件提供。没有下载附件、解包或安装补验。

## 两项打包修复

Mac专用CI漏掉原发布工作流的 `TAURI_BUNDLER_DMG_IGNORE_CI=true`，固定类别诊断确认挂载卷 `.DS_Store` 缺失的ENOENT。补齐后Mac真实CI成功。

Pi资源约12770文件，原NSIS哈希宏对每个资源都扫描整表，约1.63亿次条件比较。改为按完整目标路径建立符号索引，每资源固定次数查询；仍以实际字节计算SHA-256，保留调用方清理、missing复制回退、模型选装和升级逻辑。增加嵌套符号边界及Windows大小写冲突的fail-closed检查，没有裁剪资源。

真实NSIS3.13实验：1000项旧11.57秒、新0.24秒；12770项旧固定30秒超时、新4.88秒。实际生产函数4000项旧30秒超时，新约1.64秒通过全部哈希/大小写/特殊路径/missing/PE断言。[编译结果](../evidence/pi-actions-packages-20261031/nsis-compile-results.json)。

另用本地Mac公开程序资源12770文件、504171063字节，逐文件独立SHA核验，再用相同 `/SOLID lzma` 编译，138.45秒通过180秒上限。[完整payload实验](../evidence/pi-actions-packages-20261031/nsis-real-payload-result.json)仅为编译性能验证，输出是含Mac资源的实验PE，未执行/分发，不是Windows客户端；不能外推Windows耗时或认定旧90分钟等待只有单一原因。最终Windows安装包以真实CI通过结果为准。

## 真机测试启动

候选沿用Preview标识和0.2.6版本。先选择独立测试安装目录，再以独立数据目录启动；真实既有用户数据升级尚未验收。替换为实际程序路径：

Mac：

```sh
TTS_CLIENT_DATA_DIR="$HOME/Library/Application Support/Lingji-Pi-Test-6e353a8" "/你的测试目录/聆记 Preview.app/Contents/MacOS/tts-client"
```

Windows：

```powershell
$env:TTS_CLIENT_DATA_DIR = Join-Path $env:LOCALAPPDATA 'Lingji-Pi-Test-871176d'
& 'C:\你的测试目录\tts-client.exe'
```

独立目录需要重新配置纪要/Pi模型；包内SenseVoice可直接测试本地转录。按录制→暂停/恢复→停止排空→逐字稿→滚动/最终纪要→重点隐藏/恢复→原音→导出顺序检查，再授权所选会议文字运行Pi复盘，核对引用和重启结果。

Mac为ad-hoc签名且未公证，Windows未签名。实体音源、权限/驱动、全新机器依赖、真实云ASR/模型及长会议，仍待真机测试；CI安装探针不能替代这些验收。
