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
- 检查 Python、uv 和 Node.js 的安装状态，并可安装缺失工具的受支持版本。
- 支持浅色、深色、跟随系统的主题，以及显示语言和主题色设置。
- 支持最小化到系统托盘与应用更新。

## 💻 快速开始

前往 [Releases](https://github.com/KiraAI-Dev/KiraAI-Launcher/releases) 下载适合你的操作系统的安装包，安装后打开 **KiraAI Launcher**。

点击 **添加项目**，再选择以下任一方式：

1. **管理本地项目** — 选择一个已有的 KiraAI 项目目录，其中应包含 `main.py` 和 `requirements.txt`。
2. **下载并部署新项目** — 选择保存目录和项目名称，启动器会下载最新的 KiraAI Release 并将其纳管。
3. **连接云端实例** — 输入已运行的 KiraAI WebUI 地址。可选的 WebUI Access Token 会先通过操作系统安全存储加密，再保存到本机。

你可以在 **环境** 页面检查 Python、uv 和 Node.js，并将缺失工具下载到启动器用户数据目录下的 `environments` 目录，无需系统包管理器或管理员权限。Python 独立安装，不依赖 uv；所有环境压缩包均校验发布方提供的 SHA-256。

在 **设置 → 运行环境** 中选择 **自动选择**、**全局环境** 或 **启动器环境**。自动选择会为每个工具优先使用启动器安装的环境，缺失时使用已有全局环境；另外两种模式只使用指定来源。全局模式沿用已有安装，需要下载缺失工具时请切换至自动选择或启动器环境。环境页会标注实际使用的来源，并支持在停止本地实例和部署后卸载启动器环境。卸载会移除对应工具的全部受管版本，保留全局工具和项目文件。

所选工具立即生效，不修改系统 PATH。如果项目虚拟环境使用的 Python 与新选择不同，下次部署会重建该虚拟环境并重新安装依赖。
## ⚙️ 项目管理

在 **项目** 页面选择项目后，可进行以下操作：

- 启动或停止本地 KiraAI 实例。
- 打开 WebUI 或本地项目文件夹。
- 修改项目显示名称和 WebUI 端口。
- 为下一次本地启动配置附加启动参数和环境变量。
- 将项目从启动器中移除；移除本地项目不会删除任何项目文件。

在 **设置 → 系统行为** 中开启 **退出时保留实例运行状态** 后，退出前会记录活跃的本地实例，下次手动打开启动器或开机自启动时自动重新启动。该选项默认关闭。退出仍会停止实例，最小化到托盘则继续运行。状态在启动器正常退出时保存；强制结束、断电或未经过正常退出流程的系统重启可能无法保存。每个实例只尝试恢复一次，失败会记录在启动器日志中。

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
