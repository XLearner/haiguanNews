/**
 * 海关总署新闻发布  →  飞书多维表格
 * =====================================
 * 每天自动抓取 http://www.customs.gov.cn/customs/xwfb34/302425/index.html
 * 的新闻列表（使用 Playwright 绕过 JS 反爬），去重后写入飞书多维表格。
 *
 * 本地调试：  node customs-scraper.js --dry-run
 * 正式运行：  node customs-scraper.js
 */

import { chromium } from "playwright";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// ─── 常量 ────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));

const CONFIG = {
  // 抓取目标
  newsListUrl:
    process.env.CUSTOMS_NEWS_URL ||
    "http://www.customs.gov.cn/customs/xwfb34/302425/index.html",
  baseUrl: "http://www.customs.gov.cn",

  // 飞书多维表格
  bitableAppToken: process.env.BITABLE_APP_TOKEN,
  bitableTableId: process.env.BITABLE_TABLE_ID,

  // 飞书应用凭证
  feishuAppId: process.env.FEISHU_APP_ID,
  feishuAppSecret: process.env.FEISHU_APP_SECRET,

  // 通知 webhook
  webhookUrl: process.env.FEISHU_WEBHOOK_URL,

  // 限制
  maxNewRecords: Number(process.env.MAX_NEW_RECORDS) || 20,

  // 飞书 API 地址
  feishuApiBase: "https://open.feishu.cn/open-apis",
};

const TOKEN_CACHE_PATH = resolve(__dirname, ".cache", "feishu_token.json");

// ─── 命令行参数 ───────────────────────────────────────────
const DRY_RUN = process.argv.includes("--dry-run");
if (DRY_RUN) console.log("🔍 DRY-RUN 模式 — 只抓取不写入\n");

// ─── 工具函数 ─────────────────────────────────────────────

/** 飞书 tenant_access_token，带缓存 */
let _cachedToken = null;

async function getTenantAccessToken() {
  // 读缓存
  if (!_cachedToken) {
    try {
      if (existsSync(TOKEN_CACHE_PATH)) {
        const raw = await readFile(TOKEN_CACHE_PATH, "utf-8");
        _cachedToken = JSON.parse(raw);
      }
    } catch { /* 忽略 */ }
  }

  // 缓存有效
  if (_cachedToken && _cachedToken.expireAt > Date.now() + 60_000) {
    return _cachedToken.token;
  }

  // 重新获取
  console.log("🔑 获取新的 tenant_access_token ...");
  const res = await fetch(`${CONFIG.feishuApiBase}/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      app_id: CONFIG.feishuAppId,
      app_secret: CONFIG.feishuAppSecret,
    }),
  });

  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`飞书鉴权失败: ${data.msg} (code=${data.code})`);
  }

  _cachedToken = {
    token: data.tenant_access_token,
    expireAt: Date.now() + data.expire * 1000,
  };

  // 写缓存
  await mkdir(dirname(TOKEN_CACHE_PATH), { recursive: true });
  await writeFile(TOKEN_CACHE_PATH, JSON.stringify(_cachedToken));

  return _cachedToken.token;
}

/** 调用飞书 Open API */
async function feishuApi(path, options = {}) {
  const token = await getTenantAccessToken();
  const url = `${CONFIG.feishuApiBase}${path}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      ...options.headers,
    },
    ...options,
  });
  const data = await res.json();
  if (data.code !== 0) {
    throw new Error(`飞书 API 错误 [${path}]: ${data.msg} (code=${data.code})`);
  }
  return data;
}

// ─── 1. 抓取新闻列表 ─────────────────────────────────────

async function scrapeNewsList() {
  console.log("🌐 启动浏览器 ...");

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });

  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    viewport: { width: 1920, height: 1080 },
    locale: "zh-CN",
  });

  // 隐藏自动化痕迹
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
    window.chrome = { runtime: {} };
    // 覆盖权限查询
    const originalQuery = window.navigator.permissions.query;
    window.navigator.permissions.query = (parameters) =>
      parameters.name === "notifications"
        ? Promise.resolve({ state: Notification.permission })
        : originalQuery(parameters);
  });

  const page = await context.newPage();

  try {
    console.log(`📡 访问: ${CONFIG.newsListUrl}`);

    // 访问页面，等待 JS 挑战自动完成
    await page.goto(CONFIG.newsListUrl, {
      waitUntil: "networkidle",
      timeout: 60000,
    });

    // 额外等待，确保动态内容加载
    await page.waitForTimeout(3000);

    // 调试信息
    console.log(`   最终 URL: ${page.url()}`);
    console.log(`   页面标题: ${await page.title()}`);

    // ═══ 方法1：直接提取页面上所有带 href 的链接 ═══
    let newsItems = await page.$$eval(
      "a[href]",
      (links, baseUrl) =>
        links
          .filter((a) => {
            const text = a.textContent.trim();
            // 过滤导航/页脚等无关链接
            return (
              text.length > 10 &&
              !/^(首页|上一页|下一页|末页|更多|返回|关闭|English|网站地图|关于我们)$/.test(text)
            );
          })
          .map((a) => {
            const href = a.getAttribute("href") || "";
            const fullUrl = href.startsWith("http")
              ? href
              : `http://www.customs.gov.cn${href.startsWith("/") ? "" : "/"}${href}`;
            const parentText = a.closest("li, div, p, td")?.textContent || a.textContent || "";
            const dateMatch = parentText.match(/(\d{4}[.\-/年]\d{1,2}[.\-/月]\d{1,2}日?)/);
            return {
              title: text,
              url: fullUrl,
              date: dateMatch ? dateMatch[1] : "",
            };
          }),
      CONFIG.baseUrl
    );

    // ═══ 方法2：如果上面结果为空，尝试获取所有可见文本 ═══
    if (newsItems.length === 0) {
      console.log("   ⚠️ 方法1 无结果，尝试获取所有文本节点...");
      const allText = await page.$$eval("body *", (els) =>
        els.slice(0, 200).map((el) => ({
          tag: el.tagName,
          class: el.className,
          text: (el.textContent || "").trim().substring(0, 100),
        }))
      );
      console.log("   📄 页面元素结构（前200）:");
      for (const t of allText.slice(0, 30)) {
        if (t.text && t.text.length > 5) {
          console.log(`      <${t.tag} class="${t.class}"> ${t.text}`);
        }
      }
    }

    // ═══ 始终保存截图供诊断 ═══
    await page.screenshot({ path: "page-screenshot.png", fullPage: true });
    console.log("   📸 已保存截图 page-screenshot.png");

    // 打印 HTML 片段
    const html = await page.content();
    console.log(`   📄 页面 HTML 长度: ${html.length} 字符`);
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
    if (bodyMatch) {
      const bodyText = bodyMatch[1].replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
      console.log(`   📝 纯文本预览: ${bodyText.substring(0, 500)}`);
    }

    console.log(`✅ 抓取到 ${newsItems.length} 条新闻`);

    // 去重 & 过滤（只保留可能是新闻的链接：href 包含 customs）
    const seen = new Set();
    const valid = newsItems.filter((n) => {
      if (!n.title || !n.url) return false;
      if (seen.has(n.url)) return false;
      // 优先保留包含 /customs/ 路径的链接（海关新闻）
      seen.add(n.url);
      return true;
    });

    return valid;
  } finally {
    await browser.close();
    console.log("🔒 浏览器已关闭");
  }
}

// ─── 2. 飞书多维表格去重 & 写入 ───────────────────────────

/**
 * 获取多维表格中已有的记录 URL 集合（用于去重）
 * 假设表格中「链接」字段名为 "链接"
 */
async function getExistingUrls() {
  const existingUrls = new Set();

  // 分批拉取（每次最多 500 条，一般够用）
  let pageToken = undefined;
  let totalFetched = 0;

  do {
    const params = new URLSearchParams({ page_size: "500" });
    if (pageToken) params.set("page_token", pageToken);

    const data = await feishuApi(
      `/bitable/v1/apps/${CONFIG.bitableAppToken}/tables/${CONFIG.bitableTableId}/records?${params}`
    );

    for (const record of data.data?.items || []) {
      // 尝试 "链接" 字段（可能是文本或 URL 类型）
      const urlField =
        record.fields["链接"] ||
        record.fields["url"] ||
        record.fields["URL"] ||
        record.fields["新闻链接"] ||
        "";
      if (urlField) {
        // 飞书 URL 字段可能是 { link: "...", text: "..." } 对象
        const url = typeof urlField === "object" ? urlField.link : urlField;
        if (url) existingUrls.add(url);
      }
    }

    totalFetched += (data.data?.items || []).length;
    pageToken = data.data?.has_more ? data.data?.page_token : undefined;
  } while (pageToken);

  console.log(`📋 多维表格中已有 ${totalFetched} 条记录，${existingUrls.size} 个唯一 URL`);
  return existingUrls;
}

/** 批量写入新记录到多维表格 */
async function batchCreateRecords(records) {
  if (records.length === 0) {
    console.log("   ℹ️ 无新记录需要写入");
    return 0;
  }

  // 飞书 Bitable 单次 batch_create 上限 500 条
  const BATCH_SIZE = 500;
  let written = 0;

  for (let i = 0; i < records.length; i += BATCH_SIZE) {
    const batch = records.slice(i, i + BATCH_SIZE);
    const body = {
      records: batch.map((r) => ({
        fields: {
          标题: r.title,
          链接: { link: r.url, text: r.title }, // URL 字段类型用对象
          发布日期: r.date || "",
          来源: "海关总署",
        },
      })),
    };

    await feishuApi(
      `/bitable/v1/apps/${CONFIG.bitableAppToken}/tables/${CONFIG.bitableTableId}/records/batch_create`,
      { method: "POST", body: JSON.stringify(body) }
    );

    written += batch.length;
    console.log(`   📝 已写入 ${written}/${records.length} 条`);
  }

  return written;
}

// ─── 3. 推送通知到飞书群 ──────────────────────────────────

async function sendNotification(scraped, added, errors) {
  if (!CONFIG.webhookUrl) return;

  const statusEmoji = errors.length > 0 ? "⚠️" : "✅";
  const lines = [
    `${statusEmoji} **海关新闻抓取报告** — ${new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`,
    "",
    `📡 本次抓取: **${scraped}** 条`,
    `➕ 新增入库: **${added}** 条`,
  ];

  if (errors.length > 0) {
    lines.push("", "❌ 错误:");
    errors.forEach((e) => lines.push(`  · ${e}`));
  }

  await fetch(CONFIG.webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      msg_type: "interactive",
      card: {
        header: {
          title: { tag: "plain_text", content: "海关新闻抓取报告" },
          template: errors.length > 0 ? "red" : "green",
        },
        elements: [
          {
            tag: "markdown",
            content: lines.join("\n"),
          },
        ],
      },
    }),
  });

  console.log("📤 通知已推送");
}

// ─── 主流程 ───────────────────────────────────────────────

async function main() {
  const errors = [];
  let newsItems = [];
  let addedCount = 0;

  // Step 1: 抓取
  try {
    newsItems = await scrapeNewsList();
  } catch (err) {
    errors.push(`抓取失败: ${err.message}`);
    console.error("❌", err);
  }

  if (newsItems.length === 0) {
    errors.push("未抓到任何新闻条目，可能是页面结构变化");
    await sendNotification(0, 0, errors);
    process.exit(1);
  }

  // Step 2: Dry-run 模式只打印，不写入
  if (DRY_RUN) {
    console.log("\n📋 抓取结果预览:\n");
    console.log("-".repeat(72));
    newsItems.slice(0, 30).forEach((item, i) => {
      console.log(`${String(i + 1).padStart(3)}. ${item.title}`);
      console.log(`     ${item.url}`);
      if (item.date) console.log(`     📅 ${item.date}`);
      console.log();
    });
    console.log("-".repeat(72));
    console.log(`共 ${newsItems.length} 条${newsItems.length > 30 ? ` (仅显示前30条)` : ""}`);
    return;
  }

  // Step 3: 校验飞书配置
  if (!CONFIG.feishuAppId || !CONFIG.bitableAppToken || !CONFIG.bitableTableId) {
    console.error(
      "❌ 缺少飞书配置！请设置环境变量: FEISHU_APP_ID, BITABLE_APP_TOKEN, BITABLE_TABLE_ID"
    );
    process.exit(1);
  }

  // Step 4: 去重
  try {
    const existingUrls = await getExistingUrls();
    const newItems = newsItems.filter((item) => {
      if (existingUrls.has(item.url)) {
        console.log(`   ⏭️ 跳过已存在: ${item.title}`);
        return false;
      }
      return true;
    });

    console.log(
      `🔍 去重后: ${newItems.length} 条新增 (共抓取 ${newsItems.length} 条)`
    );

    // 限制单次写入数量
    const toAdd = newItems.slice(0, CONFIG.maxNewRecords);
    if (newItems.length > CONFIG.maxNewRecords) {
      console.log(`   ⚠️ 超过上限，只写入前 ${CONFIG.maxNewRecords} 条`);
    }

    // Step 5: 写入
    addedCount = await batchCreateRecords(toAdd);
  } catch (err) {
    errors.push(`写入多维表格失败: ${err.message}`);
    console.error("❌", err);
  }

  // Step 6: 通知
  await sendNotification(newsItems.length, addedCount, errors);

  // 汇总
  console.log("\n" + "=".repeat(50));
  console.log(`📊 抓取 ${newsItems.length} 条 | 新增 ${addedCount} 条 | 错误 ${errors.length} 个`);
  if (errors.length > 0) process.exit(1);
}

main();
