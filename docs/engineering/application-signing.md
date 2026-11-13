# 应用签名准备与个人申请路径

当前事实（2026-11-13）：本机预检未发现有效 Developer ID Application 身份；预览版 macOS 继续使用 ad-hoc 签名，Windows 与 Linux 尚未配置可信发行签名。用户已确认按中国大陆个人身份申请，尚未申请 Windows 证书。不能把配置存在或散列校验等同于可信签名完成。

运行 `npm run signing:status` 可检查证书、配置和工具的缺口。该命令不读取或打印密码、私钥、API 密钥，不签名或上传文件；`trustedArtifactVerified` 始终为 false，真实签名必须逐个验证最终产物。

## macOS 与 iOS

先由本人开通 [Apple Developer Program](https://developer.apple.com/programs/enroll/)，完成真实身份与付款。之后提供公开的 Team ID、Developer ID Application 证书名称；P12 私钥及其密码通过本机 Keychain 或受保护的 CI Secrets 配置。Mac 发行还需 hardened runtime、嵌套可执行文件签名、notarytool 公证与 stapler 验证。[Developer ID](https://developer.apple.com/developer-id/)

iOS 复用同一开发者团队，但其应用标识、授权配置及分发流程须单独配置；本轮只评估手机应用，没有创建手机项目或生成长期发布密钥。个人开发者的展示身份按 Apple 规则核验，不能用临时自签替代公开分发所需身份。

## Windows

微软 Artifact Signing 的公开信任个人通道目前只接受美国或加拿大个人，不能仅通过选择海外云区域改变身份资格。[微软申请条件](https://learn.microsoft.com/en-gb/azure/artifact-signing/quickstart)

按中国大陆个人准备时，可考察 SSL.com IV Code Signing 加 eSigner 云 HSM；最终受理取决于 CA 实名核验。IV 无需注册公司，安装程序中的发布者显示经核验的个人姓名。官网通用材料说明不能证明某一大陆个人申请必然通过。[IV 产品与申请入口](https://www.ssl.com/products/software-integrity/code-signing/iv/)

截至 2026-11-13，1 年期 IV 证书为 129 美元；eSigner Tier 1 年付 180 美元，含 240 次签名/年，基础年度合计约 309 美元。另有月付 20 美元、20 次/月方案；Tier 1 超额签名 1 美元/次。税、汇率及额外凭据另算，最终以下单报价为准。高频测试版需按 EXE、卸载器、安装器及重试的实际签名次数估算，240 次不是每月额度。[eSigner 详细计费](https://www.ssl.com/guide/esigner-pricing-for-code-signing/)

证件、地址证明与付款由本人直接提交 CA。证书到账后再接入构建产物签名和 RFC 3161 时间戳，使用 Windows 验证签名状态与发布者。SmartScreen 信誉会随发布者与文件积累，签名成功不保证首次分发没有提示。[微软代码签名选项](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options)

### 证书申请前先确认受理资格

1. 先通过 [SSL.com 官方支持](https://www.ssl.com/contact/) 确认中国大陆居民以个人身份、无注册企业，是否可申请 IV Code Signing 并使用 eSigner。同步确认居民身份证或中国护照的受理方式、地址证明种类与有效期、中文或拼音姓名的证书 Subject，以及未通过核验的退款规则；确认后再付款。
2. 在 IV 产品页选择个人代码签名和 eSigner 云 HSM。该方案无需购买 USB Token，也不要求将私钥导出为 PFX。真实姓名和地址由本人在 CA 账户填写，不用软件品牌替代个人身份。
3. 登录账户 Dashboard，进入 **perform identity verification**，使用手机拍摄有效政府照片证件并按要求完成实时活体核验。自动流程不可用时，在 **Validations** 按订单要求人工提交证件或护照资料页及手持证件合照。仅在 CA 官方入口提交材料。[身份核验步骤](https://www.ssl.com/guide/identity-validation-for-ssl-com-certificates-a-complete-guide/)
4. 审核通过后核对姓名和国家并确认，按账户指引注册 eSigner、启用多因素验证。证件缺少地址时可能需要补件；官方通用指引没有给出适用于所有大陆 IV 申请的统一账单时限，需按 CA 对该订单的要求准备。
5. 提供公开的证书 Subject、签名服务名称与 Credential ID，随后接入构建流程。密码、TOTP 种子和 API 凭据通过受保护配置管理，不发送到聊天或写入源码。

付款前可向 CA 发送以下说明；这是询问模板，尚未代为发送：

> 我是居住在中国大陆的个人开发者，没有注册企业，计划购买 IV Code Signing 和 eSigner，用于 Windows EXE/NSIS 签名及 Linux CI 自动构建。请确认目前能否受理，接受哪些中国身份证件和地址证明、是否需要翻译、证书公开姓名的写法，以及验证未通过时的退款政策。

使用云 HSM 保管私钥；不把可导出的长期 PFX 放入仓库、安装包、WGS 共享目录或普通 CI 变量。支持短期 CI 身份时，限定具体仓库、发布引用和签名 profile；其他服务使用受保护、最小权限且可轮换的凭据。

Microsoft Artifact Signing 的 Public Trust 个人申请目前仅支持美国和加拿大，当前身份不适用。SignPath Foundation 需要满足其完整开源许可及审核要求，不能直接当作本项目已可用的免费通道。[微软申请条件](https://learn.microsoft.com/en-us/azure/artifact-signing/quickstart) · [SignPath 条件](https://signpath.org/terms)

### 覆盖安装器里面的应用

当前 Linux/Windows 安装包由 WGS 构建，Windows CI 验证 WGS 的同一个安装器。必须在封装之前签署自有 EXE、DLL 和辅助程序，封装时签署卸载器，最后签最终 NSIS；不能只在 Windows CI 给外层安装器补签。保留第三方原有签名，不把上游文件统一重签为自己的作品。[Tauri Windows 签名](https://tauri.app/distribute/sign/windows/) · [NSIS 卸载器签名](https://nsis.sourceforge.io/Signing_an_Uninstaller)

签名使用 SHA-256 与 RFC 3161 时间戳。最终 Windows 验收分别核对外层安装器、安装后的自有文件和卸载器：Authenticode Valid、预期发布者及可信时间戳，并运行 SignTool 的 Authenticode 验证。`verify-windows-signature.ps1` 检查签名状态、发布者与时间戳；它存在不代表预览发布流水线已完成云签名接入。签名后重算文件摘要，后续安装检查和发布均使用该同一产物。

尚待本人完成 CA 申请，再按实际签名服务接入 WGS 打包 hook、最终产物验证和失败阻断。当前没有可用的可信签名产物；签名不能替代 SmartScreen 的信誉积累。[Microsoft SmartScreen](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/smartscreen-reputation)

## Linux 与 Android

Linux 可用发行者 GPG 密钥对包或清单做分离签名，并发布公钥指纹；APT 仓库还应签名仓库元数据。密钥保存在受控环境，公钥建立与分发不能由 SHA256 清单替代。本机尚未配置 GnuPG 和发行密钥。

Android 可使用自有发布密钥，应用签名与 Windows 公共 CA 是不同机制；未来确定手机包名与分发渠道后再生成、备份密钥。当前只检查配置缺口，不提前创建无用途的长期密钥。
