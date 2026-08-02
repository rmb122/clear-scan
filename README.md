# 清晰扫描仪

一款完全在浏览器本地运行的 PWA 证件与文档扫描器，适配手机和桌面端。支持身份证正反面拼版、护照资料页/双页展开、多页文档，以及自动边缘检测、透视裁剪、去阴影、去反光、黑白、灰度、加锐、鲜艳等处理。

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
- 去阴影无需额外下载或模型推理，可与去反光、色彩和细节增强组合。
- 项目历史保存在浏览器 IndexedDB；导出图片会重新编码，不保留原图 EXIF/定位信息。
- 支持 JPG、PNG、PDF 与多页 ZIP 导出；身份证默认合成为 A4 单页。
- 去反光会压低局部高光并对严重过曝给出重拍提示，但已经完全过曝的文字无法可靠恢复。
- 当前版本不包含 OCR、云同步、账号或服务端上传。

普通 HTTP 可测试图片上传、扫描和后处理；浏览器会限制非 localhost 地址的相机访问，以及 Service Worker/PWA 安装。部署到 HTTPS 后这些能力会自动启用。

## 开源协议

Copyright (C) 2026 rmb122

本项目以 [GNU Affero General Public License version 3](./LICENSE) 发布，SPDX 标识为 `AGPL-3.0-only`。如果你修改本项目并通过网络向用户提供服务，需要依照该协议向这些用户提供对应版本的源代码。部署版本的源代码位于 [github.com/rmb122/clear-scan](https://github.com/rmb122/clear-scan)。

完整条款以 [LICENSE](./LICENSE) 文件为准；项目使用的第三方依赖和资源仍分别遵循其各自的许可证。
