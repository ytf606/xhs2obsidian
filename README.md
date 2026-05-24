<p align="center">
  <img src="assets/logo.png" alt="XHS Sync Logo" width="120" />
</p>

<h1 align="center">XHS Sync</h1>

<p align="center">
  将小红书的<strong>收藏、点赞、个人帖子</strong>自动同步到 Obsidian，保存为带图片的 Markdown 笔记。<br/>
  Sync your Xiaohongshu (小红书/RedNote) bookmarks, likes and posts to Obsidian as Markdown notes with images.
</p>

<p align="center">
  <a href="https://github.com/ytf606/xhs2obsidian/releases/latest">
    <img src="https://img.shields.io/github/v/release/ytf606/xhs2obsidian?style=flat-square&color=ff2442" alt="Latest Release" />
  </a>
  <a href="https://github.com/ytf606/xhs2obsidian/blob/main/LICENSE">
    <img src="https://img.shields.io/github/license/ytf606/xhs2obsidian?style=flat-square" alt="License" />
  </a>
  <img src="https://img.shields.io/badge/Obsidian-Desktop%20Only-7c3aed?style=flat-square&logo=obsidian" alt="Desktop Only" />
  <img src="https://img.shields.io/badge/platform-macOS%20%7C%20Windows%20%7C%20Linux-blue?style=flat-square" alt="Platform" />
</p>

<p align="center">
  <a href="#中文说明">中文</a> | <a href="#english">English</a>
</p>

---

## 中文说明

### ✨ 功能特性

| 功能 | 说明 |
|------|------|
| 📚 **三类内容同步** | 支持同步**收藏**、**点赞**、**个人帖子** |
| 🔍 **关键词搜索** | 按关键词搜索小红书并同步匹配笔记 |
| 🖼️ **媒体下载** | 自动下载图片和视频到本地，离线可查 |
| 🤖 **AI 自动分类** | 接入 OpenAI 兼容 API，智能归类到自定义文件夹 |
| ⏱️ **定时自动同步** | 后台定时同步，新内容实时入库 |
| 🔄 **增量同步** | 记录已同步 ID，重复运行只拉取新增内容 |
| 📁 **专辑目录** | 收藏夹按专辑自动分子目录 |
| 📝 **结构化笔记** | Frontmatter 记录 ID、标签、点赞数、评论数等元数据 |

### 📸 截图预览

> 截图即将更新，欢迎贡献 PR。

### 🗂️ 生成的文件结构

同步完成后，Vault 中自动生成：

```
RedNote/
├── Bookmarks/          # 收藏的笔记
│   ├── [专辑名]/       # 开启专辑同步时按专辑分组
│   │   └── 笔记标题.md
│   └── 笔记标题.md
├── Posts/              # 个人发布的帖子
│   └── 笔记标题.md
├── Likes/              # 点赞的帖子
│   └── 笔记标题.md
├── Search/             # 搜索结果
│   └── [关键词]/
│       └── 笔记标题.md
└── Media/              # 下载的图片和视频
    └── 笔记标题/       # 每篇笔记独立媒体文件夹
        ├── 1.jpg
        ├── 2.jpg
        └── video.mp4
```

每篇笔记的 Markdown 格式：

```markdown
---
id: "6xxxxxxxxxxxxxxxxxxxxxxx"
title: "笔记标题"
author: "作者昵称"
type: bookmarks
url: "https://www.xiaohongshu.com/explore/6xxx"
tags: [美食, 生活, 旅行]
category: "AI分类结果"
createdAt: "2024-01-01T00:00:00.000Z"
syncedAt: "2024-01-02 10:30:00"
likes: 1234
comments: 56
---

笔记正文内容…

![](../Media/笔记标题/1.jpg)

![](../Media/笔记标题/2.jpg)
```

### 🚀 安装

#### 方式一：从 Release 安装（推荐）

1. 前往 [Releases](https://github.com/ytf606/xhs2obsidian/releases/latest) 下载最新的 `xhs2obsidian-x.x.x.zip`
2. 解压后将文件夹复制到 Vault 的 `.obsidian/plugins/` 目录
3. 打开 Obsidian → **设置 → 第三方插件** → 关闭「安全模式」→ 刷新列表 → 找到 **XHS Sync** → 启用

#### 方式二：从源码构建

```bash
git clone https://github.com/ytf606/xhs2obsidian.git
cd xhs2obsidian
npm install
npm run build
# 将 main.js、manifest.json、styles.css 复制到 Vault/.obsidian/plugins/xhs2obsidian/
```

> **注意：** 本插件依赖 Electron WebView，仅支持 Obsidian **桌面端**（macOS / Windows / Linux）。

### 📖 使用指南

#### 第一步：登录小红书

1. 打开 **设置 → XHS Sync**
2. 点击「**登录**」按钮
3. 在弹出的小红书内置浏览器中完成登录（支持扫码 / 手机号 / 账号密码）
4. 登录成功后点击「**登录完成，提取 Cookie**」
5. 状态显示「已登录：你的昵称」表示成功

> Cookie 有效期约 30–90 天，过期后重新登录即可，不影响已同步的笔记。

#### 第二步：选择同步目标

| 选项 | 说明 |
|------|------|
| 收藏 | 你收藏的帖子（默认） |
| 个人帖子 | 你自己发布的帖子 |
| 点赞 | 你点赞的帖子 |

#### 第三步：开始同步

- **方式 1：** 点击左侧 Ribbon 栏的云下载图标
- **方式 2：** 按 `Cmd+P` / `Ctrl+P`，搜索「同步收藏 / 同步个人帖子 / 同步点赞」

同步进度会以通知气泡实时显示，完成后提示新增条数。

### ⚙️ 配置说明

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| 根目录名 | `RedNote` | Vault 内存储目录 |
| 同步目标 | 收藏 | Ribbon 图标触发的同步类型 |
| 每批数量 | 5 | 每次 API 请求条目数，建议 5–10 |
| 同步标签 | 开启 | 将小红书话题标签写入 frontmatter |
| 同步专辑 | 关闭 | 收藏夹按专辑分子目录存放 |
| 定时自动同步 | 关闭 | 按设定间隔后台自动同步 |
| 同步间隔 | 10 分钟 | 建议 ≥10 分钟 |
| AI 分类 | 关闭 | 启用后需配置 OpenAI 兼容 API |

#### 关键词搜索设置

| 设置项 | 说明 |
|--------|------|
| 搜索关键词 | 多个关键词逐行输入 |
| 排序方式 | 综合 / 最新 / 最热 / 评论数 / 收藏数 |
| 笔记类型 | 不限 / 视频 / 图文 |
| 时间范围 | 不限 / 一天 / 一周 / 半年 |

#### AI 自动分类

配置 OpenAI 兼容 API（支持 OpenAI、OpenRouter 等）后，插件会在同步时自动将笔记归类到你设定的文件夹，例如：

```
美食、旅行、穿搭、学习、健身、家居、数码 …
```

### ❓ 常见问题

**Q：同步时提示「请先登录」**  
Cookie 已过期，重新点击「重新登录」完成一次登录即可。

**Q：同步一段时间后报错停止**  
触发了小红书的频率限制。将「每批数量」调小至 3–5，等待几分钟后重试。

**Q：图片或视频没有下载**  
小红书媒体文件有时效性，建议尽快同步。清除缓存后重新同步可重试失败项。

**Q：如何从头重新同步**  
进入设置 → 数据 → 点击「清除缓存并重新同步」。

**Q：自动同步被自动关闭了**  
遇到限流或登录失效时，插件会自动关闭自动同步以保护账号。处理原因后在设置中重新开启。

---

## English

### ✨ Features

- **Three content types**: Sync your bookmarks, liked posts, and personal posts
- **Keyword search**: Search Xiaohongshu and sync matching notes
- **Media download**: Automatically downloads images and videos locally
- **AI classification**: Categorize notes into custom folders using any OpenAI-compatible API
- **Auto sync**: Background timer-based sync for new content
- **Incremental sync**: Tracks synced IDs to avoid duplicates
- **Album folders**: Organize bookmarks by collection folders
- **Structured notes**: Frontmatter with tags, likes, comments, and metadata

### 🚀 Installation

#### Option 1: Download Release (Recommended)

1. Download the latest `xhs2obsidian-x.x.x.zip` from [Releases](https://github.com/ytf606/xhs2obsidian/releases/latest)
2. Extract and copy the folder to your Vault's `.obsidian/plugins/` directory
3. Open Obsidian → **Settings → Community plugins** → Disable safe mode → Refresh → Enable **XHS Sync**

#### Option 2: Build from Source

```bash
git clone https://github.com/ytf606/xhs2obsidian.git
cd xhs2obsidian
npm install
npm run build
# Copy main.js, manifest.json, styles.css to Vault/.obsidian/plugins/xhs2obsidian/
```

> **Note:** This plugin requires Electron WebView and only works on Obsidian **desktop** (macOS / Windows / Linux).

### 📖 Usage

1. **Login**: Go to Settings → XHS Sync → click **Login** → complete login in the built-in browser → click **Extract Cookie**
2. **Select sync target**: Choose bookmarks, likes, or personal posts in settings
3. **Sync**: Click the cloud icon in the left ribbon, or use the command palette (`Cmd/Ctrl+P`)

### ⚙️ Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| Root folder | `RedNote` | Storage directory in your vault |
| Sync target | Bookmarks | What to sync via ribbon icon |
| Batch size | 5 | Items per API request (5–10 recommended) |
| Sync tags | On | Write hashtags to frontmatter |
| Sync albums | Off | Organize bookmarks by collection |
| Auto sync | Off | Background sync at fixed interval |
| Sync interval | 10 min | Minimum 10 minutes recommended |
| AI classify | Off | Requires OpenAI-compatible API config |

### ❓ FAQ

**Q: "Please login first" error**  
Your cookie has expired. Click "Re-login" in settings to complete a new login.

**Q: Sync stops with an error**  
Rate limited by Xiaohongshu. Reduce batch size to 3–5 and wait a few minutes before retrying.

**Q: Images/videos not downloading**  
XHS media URLs expire quickly. Sync as soon as possible after saving content. Clear cache to retry failed downloads.

---

## 🤝 Contributing

Issues and PRs are welcome! Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting.

## ⚠️ Disclaimer

This plugin is not affiliated with or endorsed by Xiaohongshu (小红书). It uses the web interface for personal data access only. Use responsibly and in compliance with Xiaohongshu's Terms of Service.

## 📄 License

[MIT](LICENSE) © ytf606
