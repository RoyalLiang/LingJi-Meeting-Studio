# 用 GitHub Actions 发布测试版

当前发布基线从 **0.3.0** 开始。安装与下载入口见[客户端安装](github-client.md)，构建环境见[构建与发布](../engineering/local-release-options.md)。

完成验证后，以 SSH 推送源码与未使用的版本标签；配置、标签和版本说明必须一致。正常后续发布先核对远端 main 是本轮基线的祖先，再原子推送 main 与标签。已发布标签和附件保持不可变。

```bash
git tag -a v0.3.0 <完整源码提交> -m 'Lingji v0.3.0 public preview'
git push --atomic origin HEAD:refs/heads/main refs/tags/v0.3.0
```

`preview-release.yml` 先核对标签、源码和版本，再按下列分工运行：

1. macOS Apple Silicon 在 GitHub Actions 构建，运行回归、原生测试和隔离启动验证。
2. WGS 一次性 runner 锁定当前代码目录，在容器内串行构建 Linux DEB 和 Windows NSIS；构建前后验证源码，保留来源与摘要。
3. Windows Actions 验证 WGS 提供的同一安装包，Ubuntu Actions 补充验证同一 DEB。
4. publish 核对三个平台的来源、摘要及验证结果，通过 GitHub API 创建 pre-release 并上传三个安装包。运行期间的工作文件保留为短期 Actions artifacts。

工作流使用仓库 `GITHUB_TOKEN` 管理 Release。WGS runner 只领取一次任务，结束后自动注销，不安装常驻服务。

版本说明放在 `docs/releases/vX.Y.Z-preview.md` 的“本版变化”段落，只描述用户可感知的行为；探索、设计过程与内部优化记录放入本地 `.agent-runtime/`。

发布完成后检查 Actions 结果、源码 SHA、标签、Release 状态和附件名称、大小、digest 元数据。没有用户额外要求时，不下载、解包或安装发布附件；缺少元数据时如实报告。macOS 测试包采用 ad-hoc 签名，首次打开说明见[开发者验证](macos-trust.md)。
