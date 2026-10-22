# 豆包音频纪要本地验证（2026-10-22）

后续发布：v0.1.5 已由后台 Actions 构建发布，五附件与源码核对通过，见[发布回执](preview-v0.1.5-2026-10-22.md)。下文保留实现阶段当时的本地验证范围。

代码：`f189cf7`。范围：本地 Web、Record worker、Responses 音频纪要和真实豆包接口。未部署、未推送、未构建或发布 App 安装包。

## 真实供应商证据

使用用户授权的方舟密钥，目标 `doubao-seed-2-1-lite-260915`，完整地址 `https://ark.cn-beijing.volces.com/api/v3/responses`。只发送本地 `say` 生成的中文测试会议，不读取或上传业务会议。请求使用 `input_audio.audio_url`，值为 `data:audio/wav;base64,...`，且 `store:false`，不启用联网工具。密钥不进入本报告、源码或日志。

| 检查 | 结果 |
| --- | --- |
| 音频探针，无转录输入 | PASS；76 个输出增量，17145ms，1351 tokens |
| 语义核对 | 正确提取小林负责、下周三前提交测试结果；上线时间未定 |
| repository → worker → 纪要 pipeline → 真实豆包 | PASS；56483ms，5513 tokens，两个冻结转录版本引用、两个原音片段映射 |
| App“测试纪要”所用静音函数，真实接口 | PASS；`ok:true`，3093ms，251 tokens，非流式返回 |

语义探针把产品名称“聆记”听写为同音词，不能据此宣称真实会议准确率。工作流测试中的 ASR 为 fixture；真实模型从音频理解已由独立无转录探针验证，真实 ASR 尚未验证。

详细本地回执位于 gitignored `.agent-runtime/doubao-audio-20261022/`：`probe-result.json`、`e2e-result.json`、`target-tests.log`、`regression.log`、`lint.log`、`typecheck.log`、`build.log`。临时真实密钥测试后删除。

## 本地回归

- 豆包定向：11/11。覆盖 WAV 字节、16kHz 单声道、冻结引用、SSE 与用量、原音授权、音频过期、时间映射与窗口上限、错误不降级、虚构引用拒绝、三小时多来源窗口、原音停止排空/清理、转录修订栅栏、设置连接测试和任务模型冻结。
- 全量 Node：385/385。含保留的 ASR＋LLM 和 OpenAI Realtime 回归。
- `npm run lint`、`npm run typecheck`、`npm run build:web`：PASS。构建仍有既有大 chunk 提示。
- Web UI：隔离开发账户保存豆包模式成功，新会议原音授权默认不勾选。配置、模式和授权[截图](doubao-audio-2026-10-22/settings.png)已保存，截图使用 fixture 密钥，不调用真实转录或录音。
- 独立 Standards / Spec 双轴复核发现模型冻结和供应商告知问题，已修复并补回归；限定修复复核无剩余阻塞。

## 未验证

真实 ASR 与豆包音频理解的并行实录、真实多人会议准确率、三小时设备连续录音、浏览器休眠/断网恢复、打包 App 原生录音、长会议实际成本与延迟、部署和生产使用，均为 `NOT_VERIFIED`。三小时测试只证明拆窗规则，不是三小时实录。

配置操作见[豆包音频纪要配置](../engineering/doubao-audio.md)。
