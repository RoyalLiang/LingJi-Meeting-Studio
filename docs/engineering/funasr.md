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
