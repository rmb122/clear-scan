# 清晰扫描仪

一款完全在浏览器本地运行的 PWA 证件与文档扫描器，适配手机和桌面端。支持身份证正反面拼版、护照资料页/双页展开、多页文档，以及自动边缘检测、透视裁剪、标准/AI 去阴影、去反光、黑白、灰度、加锐、鲜艳等处理。

## 本地运行

需要 Node.js 20+ 与 pnpm。

```bash
pnpm install
pnpm dev
```

浏览器打开 Vite 输出的本地地址。生产构建与预览：

```bash
pnpm build
pnpm preview
```

仓库已包含经过 SHA-256 校验的 FP16 DocShadow 模型。若需要从本机已验证的模型重新准备静态资源：

```bash
pnpm model:prepare /path/to/docshadow_sd7k_fp16.onnx
```

## 质量检查

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm test:e2e
```

首次运行端到端测试前，若本机尚无 Playwright 浏览器，可执行 `pnpm exec playwright install chromium`。

## 隐私与能力边界

- OpenCV 边缘检测、透视校正和图像增强均在本机 Web Worker 中完成。
- 标准去阴影无需额外下载；设置页中的 59.2 MiB AI 模型只有在用户主动安装后才会分块写入 IndexedDB。
- AI 输出只用于生成低分辨率照明校正图，最终结果仍从高分辨率原图生成。卸载模型不会删除历史页面已保存的校正图。
- 项目历史保存在浏览器 IndexedDB；导出图片会重新编码，不保留原图 EXIF/定位信息。
- 支持 JPG、PNG、PDF 与多页 ZIP 导出；身份证默认合成为 A4 单页。
- 去反光会压低局部高光并对严重过曝给出重拍提示，但已经完全过曝的文字无法可靠恢复。
- 当前版本不包含 OCR、云同步、账号或服务端上传。

普通 HTTP 可测试扫描、标准后处理与 WebAssembly AI 推理，但浏览器会限制 Service Worker/PWA 安装、WebGPU 和多线程 WASM。部署到 HTTPS 后这些能力会自动启用。
