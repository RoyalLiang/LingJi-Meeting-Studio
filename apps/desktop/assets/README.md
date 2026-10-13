# 聆记应用图标

`lingji-app-icon.svg` 是可编辑母版。三片递增的翡翠色声音／书页形状延续现有标识；瓷白圆角底提高 Dock 深浅背景下的对比度。外缘保持透明，主体按小尺寸阅读重新调整。

本轮先使用 imagegen 探索材质和比例，再重绘 SVG 定稿，避免生成稿透明边缘的杂点。发行使用 SVG 导出的图标，不使用探索稿。

在项目根目录重新导出到临时目录：

```sh
npm exec --workspace apps/desktop -- tauri icon "$PWD/apps/desktop/assets/lingji-app-icon.svg" --output /tmp/lingji-icons
```

将其中的 `icon.png`、`icon.icns`、`icon.ico` 复制到 `apps/desktop/src-tauri/icons/`。现有 bundle 配置引用这三个文件。Web 页面仍使用独立的透明标识。

更新资源后需重新打包应用，已安装版本不会自动变化。不要修改已签名应用包内的图标；那会改变包的完整性。

## 液态玻璃材质变体

`lingji-app-icon-liquid-glass-concept.png` 使用现有应用图标作为参考，由 imagegen 生成：保留瓷白底座和三片书页，加入翡翠透光、折射边缘、内部反光和绿色投影。完整提示保存在 `lingji-app-icon-liquid-glass.prompt.txt` 中。

该 PNG 用于比较材质方向，尚未替换默认 SVG、PNG、ICNS 或 ICO，也未更新安装包。
