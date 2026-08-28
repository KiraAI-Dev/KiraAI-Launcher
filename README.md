<div align="center">

# ✨ KiraAI Launcher

Manage your KiraAI projects from one place

English | [简体中文](docs/README.zh.md)

[![Electron](https://img.shields.io/badge/Electron-33+-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/) [![Vue](https://img.shields.io/badge/Vue-3-42B883?logo=vuedotjs&logoColor=white)](https://vuejs.org/) [![Releases](https://img.shields.io/github/v/release/KiraAI-Dev/KiraAI-Launcher)](https://github.com/KiraAI-Dev/KiraAI-Launcher/releases) [![Last commit](https://img.shields.io/github/last-commit/KiraAI-Dev/KiraAI-Launcher)](https://github.com/KiraAI-Dev/KiraAI-Launcher/commits)

</div>

KiraAI Launcher is a cross-platform desktop application for managing local and cloud [KiraAI](https://github.com/KiraAI-Dev/KiraAI) instances. It helps you download, configure, start, and open KiraAI without working through the command line for everyday tasks.

> [!IMPORTANT]
> KiraAI Launcher is under active development. Features and behavior may change between releases.

## 🚀 Features

- Add an existing local KiraAI project.
- Download and deploy the latest KiraAI release from the official repository.
- Start and stop local projects; the launcher creates the virtual environment and installs dependencies when needed.
- Connect to a deployed KiraAI WebUI instance.
- Change local WebUI ports and set advanced launch arguments or environment variables.
- Open a project's WebUI inside the launcher or in your system browser.
- Inspect Python, uv, and Node.js environments, and install missing tools from supported versions.
- Choose light, dark, or system theme; select a display language and accent color.
- Minimize to the system tray and receive application updates.

## 💻 Quick Start

Download the installer for your operating system from [Releases](https://github.com/KiraAI-Dev/KiraAI-Launcher/releases), install it, then open **KiraAI Launcher**.

Use **New Project** to choose one of the following:

1. **Manage a local project** — select an existing KiraAI directory containing `main.py` and `requirements.txt`.
2. **Download and deploy** — select a parent folder and project name; the launcher downloads the latest KiraAI release and registers it.
3. **Connect a cloud instance** — enter the URL of a running KiraAI WebUI. An optional WebUI Access Token is encrypted with the operating system's secure storage before it is saved locally.

For local projects, install a supported Python version and make it available on `PATH`. The **Environment** page reports whether Python, uv, and Node.js are available, and can install a missing tool using the system package manager. Select a version before installation; restart the launcher after it completes so the new command path is available.

## ⚙️ Using a Project

Select a project from **Projects** and use its actions to:

- Start or stop a local KiraAI instance.
- Open the WebUI or local project folder.
- Change its display name and WebUI port.
- Configure additional launch arguments and environment variables for the next local start.
- Remove it from the launcher. Removing a local project never deletes its files.

The default local WebUI port is `5267`. Stop a project before changing its port.

## 🧪 Development

### Requirements

- Node.js 20+ and npm
- A supported desktop platform: Windows, macOS, or Linux

### Run locally

```bash
npm ci
npm run dev
```

This starts Vite and Electron together. The Vite development server uses port `5173`.

### Build and package

```bash
npm run build
npm run dist:win
```

Use `npm run dist:mac` or `npm run dist:linux` for the other supported platforms. Build artifacts are written to `release/`.

## 🗂️ Project Structure

```text
KiraAI-Launcher/
  electron/           # Electron main process and preload bridge
  src/                # Vue application and translations
  public/             # Application assets
  build/              # Packaging assets
  .github/workflows/  # Release workflow
  package.json        # Scripts, dependencies, and package settings
```

## 🔗 Related Projects

- [KiraAI](https://github.com/KiraAI-Dev/KiraAI) — the AI digital life platform managed by this launcher.
- [KiraAI Documentation](https://docs.kira-ai.top) — deployment and configuration documentation for KiraAI.
