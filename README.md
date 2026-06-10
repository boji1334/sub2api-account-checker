# Sub2API Account Model Checker

[![CI](https://github.com/boji1334/sub2api-account-checker/actions/workflows/ci.yml/badge.svg)](https://github.com/boji1334/sub2api-account-checker/actions/workflows/ci.yml)

Language: [中文](#中文) | [English](#english)

GitHub: https://github.com/boji1334/sub2api-account-checker

If this tool helps you, please give the repository a Star.

## 中文

一个面向 Sub2API 管理后台的油猴脚本，用来在“账号管理”页面批量巡检账号模型连通性。脚本走后台接口，不模拟点击“更多 / 测试连接 / 下拉模型”，所以比页面自动点击更稳定。

### 功能

- 默认测试模型：`gpt-5.5`
- 默认单账号超时：`10` 秒
- 自动同步账号页当前筛选条件，适合下拉选择 VIP 等分组后巡检完整列表
- 自动读取当前页面的 Authorization，也支持手动粘贴
- 自动分页拉取账号，逐个调用测试接口
- 成功绿色、失败红色，实时统计总数/已测/成功/失败
- 一键复制失败邮箱和失败原因
- 可选“失败自动关闭调度”，默认不自动关闭
- 支持任意 Sub2API 管理域名：`*://*/admin/accounts*`

### 一键安装

1. 安装浏览器扩展：[Tampermonkey](https://www.tampermonkey.net/)。
2. 点击安装脚本：
   [boji-account-tester.user.js](https://raw.githubusercontent.com/boji1334/sub2api-account-checker/main/boji-account-tester.user.js)
3. Tampermonkey 弹出安装页后，点击“安装”。
4. 打开你的 Sub2API 后台账号页，例如：
   `https://你的域名/admin/accounts`
5. 页面右下角会出现“账号模型巡检”面板，点击“开始巡检”。

<img width="2560" height="1347" alt="image" src="https://github.com/user-attachments/assets/2dec30db-f314-45cd-a4e5-7894754c1fc6" />


如果第 2 步只打开了纯文本页面，请全选复制内容，然后在 Tampermonkey 里“新建脚本”，粘贴保存即可。

### 推荐使用方式

1. 先在 Sub2API 后台账号页下拉选择分组、状态或搜索条件。
2. 等页面账号列表刷新完成，面板会显示“当前筛选”。
3. 确认测试模型是 `gpt-5.5`。
4. 点击“开始巡检”。
5. 巡检结束后点击“复制失败邮箱”，交给客户或运维处理。

### 自动关闭调度

“失败自动关闭调度”默认关闭。勾选后，失败账号会调用：

```text
POST /api/v1/admin/accounts/{id}/schedulable
```

请求体：

```json
{ "schedulable": false }
```

建议第一次交付客户时先不要勾选，确认结果没问题后再启用。

### 本地验证

仓库自带一个轻量自测，不需要安装依赖：

```bash
npm test
```

它会验证脚本语法、分页拉账号、`gpt-5.5` 请求体、SSE 成功/失败解析和关闭调度接口。

### 维护者发布流程

```bash
git clone https://github.com/boji1334/sub2api-account-checker.git
cd sub2api-account-checker
npm test
```

修改 `boji-account-tester.user.js` 后提升脚本头部的 `@version`，再提交并推送：

```bash
git add .
git commit -m "Release vX.Y.Z"
git push
```

用户安装的是 raw 链接，Tampermonkey 会根据 `@updateURL` 检查更新。

### 安全说明

脚本只在 `*/admin/accounts*` 页面运行，接口请求发送回当前页面的同源 Sub2API 后台。脚本不会把 Authorization、账号列表或测试结果上传到 GitHub 或第三方服务。

## English

A Tampermonkey userscript for batch-testing Sub2API account model connectivity on the admin accounts page. It uses backend API calls instead of brittle UI clicking, so it is much more reliable than automating the “More / Test connection / Model dropdown” flow.

### Features

- Default test model: `gpt-5.5`
- Default per-account timeout: `10` seconds
- Automatically follows the current account-page filters, useful after selecting a group such as VIP
- Captures the current page Authorization automatically, with manual paste fallback
- Fetches accounts page by page and tests them one by one
- Green success logs, red failure logs, and live counters
- Copy failed emails and failure reasons in one click
- Optional “disable scheduling on failure”, disabled by default
- Works with any Sub2API admin domain: `*://*/admin/accounts*`

### One-Click Install

1. Install [Tampermonkey](https://www.tampermonkey.net/).
2. Click the userscript:
   [boji-account-tester.user.js](https://raw.githubusercontent.com/boji1334/sub2api-account-checker/main/boji-account-tester.user.js)
3. When Tampermonkey opens the install page, click “Install”.
4. Open your Sub2API admin accounts page, for example:
   `https://your-domain/admin/accounts`
5. The “Account Model Checker” panel will appear at the bottom right. Click “Start”.

If step 2 opens plain text, copy all content, create a new script in Tampermonkey, paste it, and save.

### Recommended Workflow

1. Select the group, status, or search terms in the Sub2API admin accounts page.
2. Wait for the account list to refresh; the panel shows the current filter summary.
3. Confirm the test model is `gpt-5.5`.
4. Click “Start”.
5. After the run finishes, click “Copy failed emails”.

### Disable Scheduling

“Disable scheduling on failure” is off by default. If enabled, failed accounts will call:

```text
POST /api/v1/admin/accounts/{id}/schedulable
```

Body:

```json
{ "schedulable": false }
```

For customer delivery, run it once without this option first, then enable it after confirming the results.

### Local Check

The repository includes a lightweight self-test and does not require dependencies:

```bash
npm test
```

It checks script syntax, paginated account fetching, the `gpt-5.5` request body, SSE success/failure parsing, and the scheduling toggle endpoint.

### Maintainer Release Flow

```bash
git clone https://github.com/boji1334/sub2api-account-checker.git
cd sub2api-account-checker
npm test
```

After editing `boji-account-tester.user.js`, bump the userscript `@version`, then commit and push:

```bash
git add .
git commit -m "Release vX.Y.Z"
git push
```

Users install from the raw link, and Tampermonkey can check updates via `@updateURL`.

### Security

The script only runs on `*/admin/accounts*`. API calls are sent back to the current page origin. It does not upload Authorization headers, account lists, or test results to GitHub or any third-party service.
