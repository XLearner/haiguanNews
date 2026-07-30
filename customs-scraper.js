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
    const hint = data.code === 91403
      ? "\n💡 提示: 请确认 1) 已开通 bitable:app 权限 2) 已「发布新版本」使权限生效 3) 多维表格已添加此应用为协作者"
      : "";
    throw new Error(`飞书 API [${data.code}] ${data.msg}${hint}`);
  }
  return data;
}

// ─── 1. 抓取新闻列表 ─────────────────────────────────────

async function scrapeNewsList() {
  console.log("🌐 启动 Chromium ...");

  // 使用 Google Chrome（非 Chromium）+ xvfb，指纹更接近真实用户
  const browser = await chromium.launch({
    headless: false,
    channel: "chrome", // 使用系统安装的 Google Chrome
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: 1920, height: 1080 },
    locale: "zh-CN",
  });

  const page = await context.newPage();

  // 捕获控制台日志
  const consoleLogs = [];
  page.on("console", (msg) => consoleLogs.push(`[${msg.type()}] ${msg.text()}`));
  page.on("pageerror", (err) => consoleLogs.push(`[ERR] ${err.message}`));

  try {
    console.log(`📡 访问: ${CONFIG.newsListUrl}`);

    // 第一步：加载挑战页面（domcontentloaded 确保 JS 挑战脚本已加载）
    await page.goto(CONFIG.newsListUrl, {
      waitUntil: "domcontentloaded",
      timeout: 30000,
    });

    console.log("   ⏳ JS 挑战脚本已加载，等待挑战完成并刷新页面...");

    // 第二步：等待挑战完成 → 网络空闲（挑战完成后不会再有新请求）
    try {
      await page.waitForLoadState("networkidle", { timeout: 45000 });
    } catch {
      console.log("   ⚠️ networkidle 超时，继续尝试...");
    }

    // 额外缓冲
    await page.waitForTimeout(2000);

    // 第三步：再等一下确保页面完全稳定
    await page.waitForTimeout(2000);

    // 安全获取内容（页面可能在导航）
    let finalUrl, html, bodyText;
    try {
      finalUrl = page.url();
      html = await page.content();
    } catch (e) {
      console.log(`   ⚠️ 页面仍在加载，等待...`);
      await page.waitForLoadState("load", { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(1000);
      finalUrl = page.url();
      html = await page.content();
    }

    bodyText = await page.evaluate(() => document.body?.innerText || "");
    console.log(`   最终 URL: ${finalUrl}`);
    console.log(`   HTML 长度: ${html.length} 字符`);
    console.log(`   可见文本: ${bodyText.length} 字符`);

    // 打印控制台日志
    if (consoleLogs.length > 0) {
      console.log(`   📜 控制台 (${consoleLogs.length} 条):`);
      consoleLogs.slice(0, 8).forEach((l) => console.log(`      ${l.substring(0, 250)}`));
    }

    // 保存截图
    await page.screenshot({ path: "page-screenshot.png", fullPage: true });
    console.log("   📸 已保存截图");

    // 仅在 #customs_con 范围内提取链接
    const newsItems = await page.$$eval("#customs_con a[href]", (links) =>
      links
        .filter((a) => a.textContent.trim().length > 10)
        .map((a) => {
          const href = a.getAttribute("href") || "";
          const fullUrl = href.startsWith("http")
            ? href
            : `http://www.customs.gov.cn${href.startsWith("/") ? "" : "/"}${href}`;
          const parentText = a.closest("li, div, p, td")?.textContent || "";
          const dateMatch = parentText.match(/(\d{4}[.\-/年]\d{1,2}[.\-/月]\d{1,2}日?)/);
          return {
            title: a.textContent.trim(),
            url: fullUrl,
            date: dateMatch ? dateMatch[1] : "",
          };
        })
    );

    console.log(`✅ 提取到 ${newsItems.length} 个链接`);

    // 去重
    const seen = new Set();
    let listItems = newsItems.filter((n) => {
      if (!n.title || !n.url) return false;
      if (seen.has(n.url)) return false;
      seen.add(n.url);
      return true;
    });

    // 调试：打印前几条的日期
    console.log("   📋 前5条数据预览:");
    listItems.slice(0, 5).forEach((n, i) => {
      console.log(`      [${i + 1}] date="${n.date}" title="${n.title.substring(0, 40)}"`);
    });

    // ═══ 仅保留上一个自然日的新闻 ═══
    const yesterday = new Date(Date.now() - 86400000);
    const dateFormats = [
      `${yesterday.getFullYear()}年${yesterday.getMonth() + 1}月${yesterday.getDate()}日`,
      `${yesterday.getFullYear()}-${String(yesterday.getMonth() + 1).padStart(2, "0")}-${String(yesterday.getDate()).padStart(2, "0")}`,
    ];
    listItems = listItems.filter((n) => {
      if (!n.date) return true; // 没有日期的保留（避免误杀）
      return dateFormats.some((fmt) => n.date.includes(fmt));
    });
    console.log(`   📅 昨日过滤后: ${listItems.length} 条 (${dateFormats[0]})`);

    // ═══ 逐篇抓取正文内容 ═══
    console.log(`\n📰 开始抓取正文内容 (共 ${listItems.length} 篇)...`);
    for (let i = 0; i < listItems.length; i++) {
      const item = listItems[i];
      console.log(`   [${i + 1}/${listItems.length}] ${item.title.substring(0, 40)}...`);
      try {
        await page.goto(item.url, {
          waitUntil: "domcontentloaded",
          timeout: 20000,
        });
        await page.waitForLoadState("networkidle", { timeout: 15000 }).catch(() => {});
        await page.waitForTimeout(1000);

        // 从 .news_detail_con 提取正文（含图片转 Markdown）
        item.content = await page.$eval(".news_detail_con", (container, baseUrl) => {
          // 克隆节点避免修改原始 DOM
          const clone = container.cloneNode(true);

          // 图片 → Markdown 格式
          clone.querySelectorAll("img").forEach((img) => {
            const src = img.getAttribute("src") || "";
            const alt = img.getAttribute("alt") || "";
            const fullSrc = src.startsWith("http") ? src : baseUrl + (src.startsWith("/") ? "" : "/") + src;
            const md = `\n![${alt}](${fullSrc})\n`;
            img.replaceWith(document.createTextNode(md));
          });

          return clone.textContent?.trim() || "";
        }, CONFIG.baseUrl).catch(() => "");

        // 兜底：选择器没命中
        if (!item.content) {
          item.content = await page.$eval("body", (body) => {
            return (body.textContent || "").trim().substring(0, 5000);
          }).catch(() => "");
        }

        console.log(`      正文: ${item.content.length} 字符`);
      } catch (err) {
        console.log(`      ⚠️ 抓取失败: ${err.message}`);
        item.content = "";
      }
    }

    return listItems;
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
      // 从「内容」(URL字段) 或「标题」提取去重标识
      const urlField =
        record.fields["内容"] ||
        record.fields["链接"] ||
        record.fields["url"] ||
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
      records: batch.map((r) => {
        // 日期字符串 → 毫秒时间戳（飞书 DateTime 字段要求）
        let dateTs = 0;
        if (r.date) {
          const normalized = r.date.replace(/[年月]/g, "-").replace(/[日]/g, "").replace(/\./g, "-");
          const parsed = Date.parse(normalized);
          dateTs = Number.isNaN(parsed) ? 0 : parsed;
        }

        const fields = {
          标题: r.title,
          来源: "海关总署",
          内容: r.content || "",
          摘要: r.url,
        };
        if (dateTs) fields["时间"] = dateTs;

        return { fields };
      }),
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
  // ══════════════════════════════════════════════════════════
  console.log("══════════════════════════════════════════════");
  console.log("  VERSION: v3 — selector-free, link-based extraction");
  console.log("  COMMIT:  ebe0009");
  console.log("  此版本不使用 waitForSelector");
  console.log("══════════════════════════════════════════════");

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
