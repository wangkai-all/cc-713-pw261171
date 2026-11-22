/* test-page-smoke.mjs
 * 用最小 DOM 桩在 Node 中执行 app.js，冒烟验证主要交互路径不抛异常：
 * 载入演示数据 -> 渲染 -> 选中组 -> 锁定边界 -> 不可行情形 -> 自测。
 * 运行：node test-page-smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

/* ---------------- 最小 DOM 桩 ---------------- */
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.attributes = {};
    this.style = {};
    this.listeners = {};
    this._text = '';
    this.className = '';
    this.hidden = false;
    this.value = '';
    this.checked = false;
  }
  appendChild(c) { this.children.push(c); return c; }
  setAttribute(k, v) { this.attributes[k] = String(v); }
  getAttribute(k) { return k in this.attributes ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }
  addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); }
  removeEventListener() {}
  dispatch(t, ev) {
    (this.listeners[t] || []).forEach((f) => f(ev || { preventDefault() {}, target: this }));
  }
  querySelector(sel) {
    const want = sel.toUpperCase();
    const walk = (el) => {
      for (const c of el.children) {
        if (c.tagName === want) return c;
        const r = walk(c);
        if (r) return r;
      }
      return null;
    };
    return walk(this);
  }
  getBoundingClientRect() { return { left: 0, top: 0, bottom: 20, width: 100, height: 20 }; }
  set textContent(v) { this._text = String(v); this.children = []; }
  get textContent() {
    if (!this.children.length) return this._text;
    return this.children.map((c) => (c.textContent !== undefined ? c.textContent : '')).join('');
  }
  set innerHTML(v) { if (v === '') this.children = []; }
  click() { this.dispatch('click'); }
}

const byId = new Map();
const mk = (id, tag) => { const el = new El(tag || 'div'); byId.set(id, el); return el; };

// 与 index.html 中 id 一一对应
const ids = ['root', 'themeToggle', 'loadDemo', 'fileInput', 'parsePaste', 'pasteArea',
  'downloadTemplate', 'minWeight', 'maxGroups', 'lockedBoundary', 'clearLock',
  'runSelfTest', 'selfTestResult', 'dataSummary', 'importMsgs', 'batchRow',
  'batchChecks', 'missingCard', 'statusLine', 'rateLegend', 'weightLegend',
  'rateChart', 'weightChart', 'groupTable', 'groupDetail', 'tooltip'];
for (const id of ids) mk(id);
byId.get('minWeight').value = '120';
byId.get('maxGroups').value = '6';
byId.get('lockedBoundary').value = '';
const tbody = new El('tbody');
byId.get('groupTable').appendChild(new El('thead'));
byId.get('groupTable').appendChild(tbody);
byId.get('tooltip').hidden = true;

globalThis.document = {
  documentElement: new El('html'),
  getElementById: (id) => byId.get(id) || null,
  createElement: (t) => new El(t),
  createElementNS: (ns, t) => new El(t),
  createTextNode: (s) => ({ nodeType: 3, textContent: String(s) }),
  addEventListener() {},
};
globalThis.window = {
  matchMedia: () => ({ matches: false }),
  innerWidth: 1280,
  innerHeight: 800,
};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '#222222' });

globalThis.BinningCore = require('./binning-core.js');

/* ---------------- 加载 app.js ---------------- */
const code = readFileSync(new URL('./app.js', import.meta.url), 'utf8');
(0, eval)(code);

/* ---------------- 断言 ---------------- */
let failures = 0;
const check = (cond, msg) => {
  if (!cond) { failures++; console.error('FAIL:', msg); }
  else console.log('ok:', msg);
};
const text = (id) => byId.get(id).textContent;

// 1. 初始化后演示数据已载入并渲染
check(text('dataSummary').includes('个不同评分'), '数据摘要已渲染：' + text('dataSummary'));
check(tbody.children.length === 6, '分组表应有 5 组 + 1 缺失行，得到 ' + tbody.children.length);
check(byId.get('rateChart').children.length > 0, '缺陷率图已绘制');
check(byId.get('weightChart').children.length > 0, '权重图已绘制');
check(text('statusLine').includes('存在满足限制的切法'), '状态行显示可行');
check(text('missingCard').includes('缺失评分'), '缺失评分单独统计卡片存在');
check(byId.get('batchChecks').children.length === 6, '批次勾选框 6 个');

// 2. 点击第一组 -> 组详情
tbody.children[0].dispatch('click');
check(text('groupDetail').includes('第 1 组'), '点击后组详情显示第 1 组');
check(text('groupDetail').includes('来源批次'), '组详情包含来源批次表');

// 3. 锁定业务边界 80 -> 显示损失增加
byId.get('lockedBoundary').value = '80';
byId.get('lockedBoundary').dispatch('change');
check(text('statusLine').includes('锁定边界 80'), '锁定边界后状态行显示损失对比');
check(!text('statusLine').includes('没有满足限制的切法'), '锁定 80 仍可行');

// 4. 最大组数 1 + 锁定边界 -> 明确不可行
byId.get('maxGroups').value = '1';
byId.get('maxGroups').dispatch('change');
check(text('statusLine').includes('没有满足限制的切法'), '锁定+组数1 时明确报告不可行');

// 5. 恢复组数，最低权重调大 -> 不可行并说明原因
byId.get('maxGroups').value = '6';
byId.get('lockedBoundary').value = '';
byId.get('minWeight').value = '99999';
byId.get('minWeight').dispatch('change');
check(text('statusLine').includes('没有满足限制的切法'), '最低权重过大时明确报告不可行');
check(text('statusLine').includes('最低样本权重'), '不可行原因包含权重说明');

// 6. 恢复默认 -> 可行
byId.get('minWeight').value = '120';
byId.get('minWeight').dispatch('change');
check(text('statusLine').includes('存在满足限制的切法'), '恢复默认约束后可行');

// 7. 自测（内部 setTimeout 30ms）
byId.get('runSelfTest').dispatch('click');
await new Promise((r) => setTimeout(r, 500));
check(text('selfTestResult').startsWith('✓'), '页内穷举核对通过：' + text('selfTestResult').slice(0, 60) + '…');

if (failures) {
  console.error('共 ' + failures + ' 处失败');
  process.exit(1);
}
console.log('页面冒烟测试全部通过。');
