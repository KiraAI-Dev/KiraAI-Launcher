<div align="center">

# ✨ KiraAI Launcher

一站式管理你的 KiraAI 项目

[English](../README.md) | 简体中文

[![Electron](https://img.shields.io/badge/Electron-33+-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/) [![Vue](https://img.shields.io/badge/Vue-3-42B883?logo=vuedotjs&logoColor=white)](https://vuejs.org/) [![Releases](https://img.shields.io/github/v/release/KiraAI-Dev/KiraAI-Launcher)](https://github.com/KiraAI-Dev/KiraAI-Launcher/releases) [![Last commit](https://img.shields.io/github/last-commit/KiraAI-Dev/KiraAI-Launcher)](https://github.com/KiraAI-Dev/KiraAI-Launcher/commits)

</div>

KiraAI Launcher 是一款跨平台桌面应用，用于管理本地和云端的 [KiraAI](https://github.com/KiraAI-Dev/KiraAI) 实例。它可以帮助你下载、配置、启动并打开 KiraAI，日常使用无需频繁操作命令行。

> [!IMPORTANT]
> KiraAI Launcher 正在积极开发中，功能与行为可能会在不同版本间变化。

## 🚀 功能特性

- 添加已有的本地 KiraAI 项目。
- 从官方仓库下载并部署最新的 KiraAI Release。
- 启动和停止本地项目；需要时自动创建虚拟环境并安装依赖。
- 连接已经部署的 KiraAI WebUI 实例。
- 修改本地 WebUI 端口，并设置附加启动参数或环境变量。
- 在启动器内或系统浏览器中打开项目 WebUI。
- 检查 Python、uv 和 Node.js 的安装状态。
- 支持浅色、深色、跟随系统的主题，以及显示语言和主题色设置。
- 支持最小化到系统托盘与应用更新。

## 💻 快速开始

前往 [Releases](https://github.com/KiraAI-Dev/KiraAI-Launcher/releases) 下载适合你的操作系统的安装包，安装后打开 **KiraAI Launcher**。

点击 **添加项目**，再选择以下任一方式：

1. **管理本地项目** — 选择一个已有的 KiraAI 项目目录，其中应包含 `main.py` 和 `requirements.txt`。
2. **下载并部署新项目** — 选择保存目录和项目名称，启动器会下载最新的 KiraAI Release 并将其纳管。
3. **连接云端实例** — 输入已运行的 KiraAI WebUI 地址。可选的 WebUI Access Token 会先通过操作系统安全存储加密，再保存到本机。

管理本地项目时，请先安装受支持版本的 Python，并将其加入 `PATH`。你可以在 **环境** 页面查看 Python、uv 和 Node.js 是否可用。

## ⚙️ 项目管理

在 **项目** 页面选择项目后，可进行以下操作：

- 启动或停止本地 KiraAI 实例。
- 打开 WebUI 或本地项目文件夹。
- 修改项目显示名称和 WebUI 端口。
- 为下一次本地启动配置附加启动参数和环境变量。
- 将项目从启动器中移除；移除本地项目不会删除任何项目文件。

本地 WebUI 默认端口为 `5267`。修改端口前需要先停止项目。

## 🧪 开发指南

### 环境要求

- Node.js 20+ 与 npm
- Windows、macOS 或 Linux

### 本地运行

```bash
npm ci
npm run dev
```

该命令会同时启动 Vite 和 Electron。Vite 开发服务器使用端口 `5173`。

### 构建与打包

```bash
npm run build
npm run dist:win
```

macOS 和 Linux 分别使用 `npm run dist:mac`、`npm run dist:linux`。构建产物会输出到 `release/`。

## 🗂️ 项目结构

```text
KiraAI-Launcher/
  electron/           # Electron 主进程与 preload 通信桥
  src/                # Vue 应用与翻译文本
  public/             # 应用资源
  build/              # 打包资源
  .github/workflows/  # 发布工作流
  package.json        # 脚本、依赖与打包配置
```

## 🔗 相关项目

- [KiraAI](https://github.com/KiraAI-Dev/KiraAI) — 本启动器管理的 AI 数字生命平台。
- [KiraAI 文档](https://docs.kira-ai.top/zh/) — KiraAI 的部署与配置文档。
