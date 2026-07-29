# 海关总署新闻 · 每日自动抓取 → 飞书多维表格

每天自动抓取 [海关总署-新闻发布](http://www.customs.gov.cn/customs/xwfb34/302425/index.html) 的最新新闻列表，去重后写入飞书多维表格，并通过 GitHub Actions 免费定时执行。

## 工作原理

```
GitHub Actions (每日 9:00 触发)
  │
  ▼
Playwright (Headless Chromium)
  │  绕过 JS 挑战反爬，执行页面 JavaScript
  ▼
提取 ul.news_list > li 中的新闻标题、链接、日期
  │
  ▼
飞书 Open API
  │  查询多维表格已有记录 → 去重 → 批量写入新增
  ▼
飞书群 Webhook 通知（可选）
```

## 快速开始（3 步）

### 第 1 步：飞书侧配置

#### 1.1 创建飞书应用

1. 打开 [飞书开发者后台](https://open.feishu.cn/app)
2. 点击「创建企业自建应用」→ 填写名称（如「海关新闻抓取」）
3. 进入应用 →「凭证与基础信息」→ 复制 **App ID** 和 **App Secret**

#### 1.2 开通权限

应用页面 →「权限管理」→ 搜索并开通以下权限：

| 权限 | 说明 |
|------|------|
| `bitable:app` | 访问多维表格 |

> 开通后点击「发布新版本」使权限生效。

#### 1.3 创建多维表格

1. 在飞书中新建一个**多维表格**（Bitable）
2. 按以下结构创建**字段**（列）：

| 字段名 | 字段类型 | 说明 |
|--------|----------|------|
| 标题 | 文本 | 新闻标题 |
| 链接 | 超链接 | 新闻 URL |
| 发布日期 | 文本 | 如 `2024-07-29` |
| 来源 | 文本 | 固定填「海关总署」 |

3. 复制表格信息：
   - 打开多维表格 → 浏览器地址栏
   - `https://xxx.feishu.cn/base/{BITABLE_APP_TOKEN}?table={TABLE_ID}`
   - 分别复制 `BITABLE_APP_TOKEN` 和 `TABLE_ID`

#### 1.4 飞书群通知（可选）

1. 飞书群聊 → 设置 → 群机器人 → 添加自定义机器人
2. 复制 Webhook URL

---

### 第 2 步：GitHub 配置

1. 在 GitHub 新建仓库（或使用已有仓库），将本项目文件上传
2. 仓库 → **Settings → Secrets and variables → Actions**
3. 添加以下 **Repository secrets**：

| Secret 名称 | 内容 |
|-------------|------|
| `FEISHU_APP_ID` | 第 1.1 步的 App ID |
| `FEISHU_APP_SECRET` | 第 1.1 步的 App Secret |
| `BITABLE_APP_TOKEN` | 第 1.3 步的表格 Token |
| `BITABLE_TABLE_ID` | 第 1.3 步的 Table ID |
| `FEISHU_WEBHOOK_URL` | （可选）第 1.4 步的 Webhook |
| `CUSTOMS_NEWS_URL` | （可选）默认已填好，若有变化可覆盖 |

---

### 第 3 步：测试运行

1. 仓库 → **Actions** → 左侧「海关新闻每日抓取」
2. 点击 **「Run workflow」** → 绿色按钮手动触发
3. 等待约 2-3 分钟，查看运行日志
4. 检查飞书多维表格是否有新数据

---

## 本地调试

```bash
# 1. 安装
npm install
npx playwright install chromium

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env 填入你的飞书凭证

# 3. 加载环境变量 & 试运行（不写入多维表格）
source .env && node customs-scraper.js --dry-run

# 4. 正式运行（写入真实数据）
source .env && node customs-scraper.js
```

---

## 定时配置

GitHub Actions 默认配置为**北京时间每天上午 9:00** 执行。修改 [.github/workflows/daily-scrape.yml](.github/workflows/daily-scrape.yml) 中的 `cron` 即可调整：

```yaml
# cron 是 UTC 时间，北京时间 = UTC + 8
# 下面示例：
# "0 1 * * *"   → 北京时间 9:00
# "0 6 * * *"   → 北京时间 14:00
# "30 0 * * 1-5" → 北京时间 8:30 (仅工作日)
```

> ⚠️ GitHub Actions 免费额度：公开仓库无限，私有仓库每月 2000 分钟。每天运行一次大约消耗 1-2 分钟/次，完全够用。

---

## 反爬应对说明

海关总署官网使用 CDN 层面的 JavaScript 挑战（`$_ts` 机制），普通 HTTP 请求无法通过：

- **飞书工作流**（纯 HTTP） → ❌ 拦截，返回 412 + JS 挑战页
- **curl / Python requests** → ❌ 同样被拦截
- **Playwright (Headless Chrome)** → ✅ 能执行 JS，正常获取内容

本方案通过 GitHub Actions 运行 Playwright，免费且稳定。
