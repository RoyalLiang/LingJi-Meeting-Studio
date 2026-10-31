# 应用内置本地转录

## Windows 模型选装（v0.1.19）

安装首页默认勾选“安装本地 SenseVoice 离线转录模型（推荐）”。保持勾选即可在应用内使用本地转录，无需另开服务器。取消后只跳过新模型文件，完整安装包的下载大小不变；没有本地模型时，在设置中选择并配置云端转录服务。应用不会自动切换已有服务或上传录音。

原安装位置的非降级 NSIS 升级，如取消模型且已有模型，会使用覆盖升级保留原模型。更换安装位置属于新安装；取消勾选不能代替卸载已有模型。设置若显示本地模型未安装，可选择云端服务，或重新安装并勾选模型。纪要模型配置沿用现有设置。


从 v0.1.17 测试版起，Windows x64 与 macOS Apple Silicon 安装包携带完整的 SenseVoiceSmall INT8、Silero VAD 与 sherpa-onnx 原生运行时。无需安装 Python、额外下载模型或手动运行转录服务器。在“设置 → 会议理解”选择“ASR＋LLM · 转录后整理”，再在“转录服务”选择“本地转录 · SenseVoice（已内置）”即可开始；未配置云端服务的新安装默认使用此项。

应用通过私有子进程在 CPU 上推理，按需启动，空闲三分钟释放，真正退出时回收。它不监听本机 HTTP 端口。本地模式不需要 API Key；纪要仍使用独立配置的豆包等模型。已有云端或自定义 FunASR 配置不会被自动覆盖。

本地转录采用短批次处理，保留音频标识、持久化确认、重试、转录版本与原音溯源。静音由 VAD 过滤；保留整段上下文交给模型。当前不提供本地说话人分离或自定义热词，不把短批次称为供应商流式 partial。中文、英文、日语、韩语、粤语为上游模型范围；本轮只对中文、英文和静音公开样本做了实际验证。

模型版本固定为 `sensevoice-small-2024-07-17-int8`，原生运行时 `sherpa-onnx 1.13.8 / ONNX Runtime 1.28.2`。资源来源、固定 revision、下载摘要、权重协议与代码许可见 `services/records/src/local-asr-resources.json` 以及安装目录 `client-backend/local-asr/NOTICE.txt`、`licenses/`。模型数据启动前校验；原生库可能因 macOS 签名而改变摘要，其来源由构建时 npm SRI 和最终安装包校验和关联。

公开短样本存在已观察到的 INT8 识别差异（英文 gold/code 等），不作为会议准确率承诺。真实会议、混合语种、噪声、多人及长时稳定性需独立评估；遇到错误可切回现有云端转录或高级外部服务。会议原音保存期内可重新处理，人工修订不会被后台覆盖。

以下外部服务方式继续作为高级配置保留。

# FunASR＋SenseVoice 转录

聆记可连接本机或私有 FunASR 的兼容转录服务，默认识别模型为 SenseVoiceSmall。FunASR 负责推理和模型 VAD，SenseVoice 负责语音识别；会议纪要继续使用你配置的豆包等模型。旧的豆包 ASR、Deepgram 和兼容接口继续可用。

## 启动本机服务

以下 CPU 路径已在 Apple Silicon / Python 3.12 上验证。请使用独立虚拟环境；首次启动会下载模型，需保持网络可用并预留数 GiB 磁盘空间。

```sh
python3.12 -m venv "$HOME/lingji-funasr"
"$HOME/lingji-funasr/bin/python" -m pip install 'funasr==1.4.14' 'torch==2.8.0' 'torchaudio==2.8.0' 'numpy==1.26.4' fastapi uvicorn python-multipart soundfile
OMP_NUM_THREADS=4 VECLIB_MAXIMUM_THREADS=4 "$HOME/lingji-funasr/bin/funasr-server" --host 127.0.0.1 --device cpu --model sensevoice --port 18586
```

等服务完成模型加载后，在另一个终端检查：

```sh
curl --fail http://127.0.0.1:18586/health
```

健康检查成功只表示服务可访问；还应在 App 内测试转录并试录核对。服务终端需保持运行，Ctrl-C 可停止。本版连接已部署服务，安装包不附带 Python 或模型权重，也不自动安装后台服务。

## App 配置

打开「设置与诊断 → 模型与转录服务」，选择：

| 字段 | 值 |
| --- | --- |
| 转录服务 | FunASR · SenseVoice 本地转录 |
| FunASR 转录地址 | `http://127.0.0.1:18586/v1/audio/transcriptions` |
| 识别模型 | `sensevoice` |
| 服务密钥 | 本机未启用认证时留空；私有网关按实际配置填写 |
| 会议理解 | ASR＋LLM · 转录后整理 |

保存后点击「测试转录」。文字模型地址、模型名与密钥仍填你已开通的豆包等服务。也可搭配「豆包音频 · 独立 ASR 留证」或 OpenAI Realtime，让 FunASR 并行提供引用原文；这些模式仍会按逐场授权发送原音到对应服务。选择「仅豆包音频模型」会使用该模型完成转录，跳过独立 FunASR。

这是完整请求地址，不能仅填写主机地址；SenseVoice 仓库 `api.py` 的 `/api/v1/asr` 协议也不适用。私有 FunASR 服务可改填其完整兼容接口，模型名需与服务实际支持的别名一致，例如单独部署的 `paraformer`；本轮真实模型验证使用 `sensevoice`。本机无认证服务仅监听回环地址；部署到其他设备时按服务文档配置 HTTPS 与认证。生产后端仅为回环 FunASR 地址允许 HTTP，其他服务要求 HTTPS。

## 会中转录与收尾

录音仍先落盘并确认接收。聆记按每个音源独立聚合连续音频，在静音尾部优先提交；持续讲话约 20 秒触发提交，单次最多 30 秒。暂停和结束会提交不足一窗的剩余音频，已声明但尚未接收完整的尾包会继续等待补传。该路径是短批次转录，不是 SenseVoice 原生流式 partial。

转录片段记录源音轨、时间范围、原始包标识、模型和转录版本，继续支持搜索、原音定位和纪要引用。后台不会重写人工修订。服务故障会明确提示，录音保持保存，可在恢复服务后点击「重新处理」；不会静默切换到云端 ASR。

SenseVoiceSmall 不直接提供会议纪要、真实姓名或独立说话人分离。时间范围来自聆记录音包，不代表逐词强制对齐。CPU 性能、噪声、多方重叠讲话和会议术语会影响结果；真实长会议及各硬件持续双路能力需分别验收。

## 后端变量

```dotenv
ASR_PROVIDER=funasr
FUNASR_API_URL=http://127.0.0.1:18586/v1/audio/transcriptions
FUNASR_MODEL=sensevoice
# FUNASR_API_KEY=仅服务要求认证时填写
MINUTES_MODE=asr-llm
```

密钥仅存后端，不要放入 `VITE_*`。切换服务后新工作使用新配置；已失败录音需显式重新处理。若更改服务或模型时旧请求仍在执行，其结果会被丢弃并重新排队，避免把旧模型结果提交为新配置的转录。

来源：[SenseVoice 官方仓库](https://github.com/QwenAudio/SenseVoice)、[FunASR 服务接入](https://github.com/modelscope/FunASR/blob/main/docs/agent_integration.md)、[兼容接口契约](https://github.com/modelscope/FunASR/tree/main/examples/openai_api)。模型权重许可与代码许可分别以所用模型卡和制品说明为准。
