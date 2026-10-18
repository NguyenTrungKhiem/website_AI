// Công cụ dev: chụp màn hình + cây accessibility của tab Flow để viết bộ chọn (selector).
// Chạy từ thư mục gốc dự án:  node scripts/flow-inspect.mjs [tên-file-ra]
import fs from 'node:fs';
import path from 'node:path';
import { flowPage } from '../server/flow.js';

const name = process.argv[2] || 'flow';
const out = path.resolve('data/tmp');
fs.mkdirSync(out, { recursive: true });

const page = await flowPage();
await page.bringToFront();
console.log('URL:', page.url());
await page.screenshot({ path: path.join(out, `${name}.png`) });
const snap = await page.locator('body').ariaSnapshot();
fs.writeFileSync(path.join(out, `${name}.aria.yml`), snap);
console.log(snap.slice(0, 6000));
process.exit(0);
