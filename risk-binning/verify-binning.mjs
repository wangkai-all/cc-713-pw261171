/* verify-binning.mjs
 * 小样本穷举核对：对随机小样本，逐一比较动态规划（optimalBinning）
 * 与穷举全部切分（bruteForceBinning）的可行性与最优损失。
 *
 * 运行：node verify-binning.mjs [trials]
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const BC = require('./binning-core.js');

const rand = BC._internals.mulberry32(20261122);
const TRIALS = Number(process.argv[2] || 500);

let failures = 0;
const fail = (msg) => { failures++; console.error('FAIL:', msg); };

/* ---------- 1. 随机小样本：DP vs 穷举 ---------- */
let checked = 0, infeasibleBoth = 0, lockedCases = 0;
for (let t = 0; t < TRIALS; t++) {
  const n = 2 + Math.floor(rand() * 10); // 2..11 个不同评分
  const scores = [];
  for (let i = 0; i < n; i++) {
    const w = 1 + Math.floor(rand() * 6);
    // 随机缺陷率（刻意不单调，考验单调约束）
    const p = rand();
    let d = 0;
    for (let k = 0; k < w; k++) if (rand() < p) d++;
    scores.push({ score: i + 1, w, d });
  }
  const opts = {
    minWeight: 1 + Math.floor(rand() * 10),
    maxGroups: 1 + Math.floor(rand() * 5),
    lockedCut: rand() < 0.5 ? null : 1 + Math.floor(rand() * (n - 1)),
  };
  if (opts.lockedCut !== null) lockedCases++;

  const dp = BC.optimalBinning(scores, opts);
  const bf = BC.bruteForceBinning(scores, opts);

  if (dp.feasible !== bf.feasible) {
    fail(`trial ${t}: 可行性不一致 dp=${dp.feasible} bf=${bf.feasible} opts=${JSON.stringify(opts)}`);
    continue;
  }
  if (!dp.feasible) { infeasibleBoth++; continue; }

  const tol = 1e-7 * Math.max(1, Math.abs(bf.loss));
  if (Math.abs(dp.loss - bf.loss) > tol) {
    fail(`trial ${t}: 损失不一致 dp=${dp.loss} bf=${bf.loss} opts=${JSON.stringify(opts)}`);
    continue;
  }
  // 独立校验 DP 解本身满足全部约束
  checkSolution(scores, dp, opts, `trial ${t} (dp)`);
  checkSolution(scores, bf, opts, `trial ${t} (bf)`);
  checked++;
}

/* ---------- 2. 单元检查 ---------- */
// 2a. 聚合：相同评分合并、缺失单独统计
{
  const agg = BC.aggregateScores([
    { score: 5, defect: 1, weight: 2, batch: 'A' },
    { score: 5, defect: 0, weight: 3, batch: 'A' },
    { score: 3, defect: 1, weight: 1, batch: 'B' },
    { score: null, defect: 1, weight: 4, batch: 'B' },
    { score: NaN, defect: 0, weight: 1, batch: 'B' },
  ]);
  if (agg.scores.length !== 2) fail('聚合：不同评分数应为 2，得到 ' + agg.scores.length);
  if (agg.scores[0].score !== 3 || agg.scores[1].score !== 5) fail('聚合：评分未按升序');
  if (agg.scores[1].w !== 5 || agg.scores[1].d !== 2 || agg.scores[1].defects !== 1) {
    fail('聚合：score=5 的权重/缺陷统计错误 ' + JSON.stringify(agg.scores[1]));
  }
  if (agg.missing.n !== 2 || agg.missing.w !== 5 || agg.missing.defects !== 1) {
    fail('聚合：缺失评分统计错误 ' + JSON.stringify(agg.missing));
  }
}

// 2b. 落组约定：左闭右开，端点开放
{
  const cuts = [10, 20];
  const cases = [
    [-Infinity, 0], [9.999, 0], [10, 1], [15, 1], [19.999, 1], [20, 2], [1e9, 2],
  ];
  for (const [x, want] of cases) {
    const got = BC.assignGroup(cuts, x);
    if (got !== want) fail(`落组：x=${x} 应入组 ${want}，得到 ${got}`);
  }
}

// 2c. 锁定边界确实成为组边界
{
  const scores = [1, 2, 3, 4, 5, 6].map((s) => ({ score: s, w: 5, d: s <= 3 ? 0 : 4 }));
  const r = BC.optimalBinning(scores, { minWeight: 1, maxGroups: 6, lockedCut: 3 });
  if (!r.feasible) fail('锁定边界：应有可行解');
  else {
    const hasCut = r.groups.some((g) => g.end === 2);
    if (!hasCut) fail('锁定边界：解中第 3/4 个评分之间应为组边界');
  }
}

// 2d. 不可行情形：总权重低于最低组权重
{
  const scores = [{ score: 1, w: 2, d: 0 }, { score: 2, w: 2, d: 1 }];
  const r = BC.optimalBinning(scores, { minWeight: 100, maxGroups: 3 });
  if (r.feasible) fail('不可行情形：总权重 < 最低组权重却返回可行');
  const b = BC.bruteForceBinning(scores, { minWeight: 100, maxGroups: 3 });
  if (b.feasible) fail('不可行情形：穷举与 DP 不一致');
}

// 2e. CSV 解析：中文表头、缺失评分、是/否、引号
{
  const csv = '评分,是否发现缺陷,样本权重,生产批次\n72.5,是,2,"P2601"\n,否,1,P2601\nNA,1,3,P2602\n';
  const { rows, errors } = BC.parseCSV(csv);
  if (errors.length) fail('CSV 解析不应报错：' + JSON.stringify(errors));
  if (rows.length !== 3) fail('CSV 行数应为 3，得到 ' + rows.length);
  if (rows[0].score !== 72.5 || rows[0].defect !== 1 || rows[0].weight !== 2 || rows[0].batch !== 'P2601') {
    fail('CSV 第 1 行解析错误 ' + JSON.stringify(rows[0]));
  }
  if (rows[1].score !== null || rows[2].score !== null) fail('CSV 缺失评分应为 null');
}

// 2f. 演示数据冒烟：<= 40 个不同评分，DP 可行，组数 <= 上限
{
  const demo = BC.makeDemoData();
  const agg = BC.aggregateScores(demo.rows.filter((r) => r.batch !== 'P2612'));
  if (agg.scores.length > 40) fail('演示数据不同评分超过 40：' + agg.scores.length);
  const r = BC.optimalBinning(agg.scores, { minWeight: 120, maxGroups: 6 });
  if (!r.feasible) fail('演示数据：默认约束下应可行');
  else if (r.groups.length > 6) fail('演示数据：组数超过上限');
  if (agg.missing.n === 0) fail('演示数据：应包含缺失评分行');
}

/* ---------- 工具 ---------- */
function checkSolution(scores, sol, opts, tag) {
  const groups = sol.groups;
  if (groups.length > opts.maxGroups) fail(`${tag}: 组数 ${groups.length} 超过上限 ${opts.maxGroups}`);
  let covered = 0;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    if (g.start !== covered) fail(`${tag}: 组 ${i} 未连续覆盖（start=${g.start}, 期望 ${covered}）`);
    covered = g.end + 1;
    if (g.weight < opts.minWeight - 1e-9) fail(`${tag}: 组 ${i} 权重 ${g.weight} 低于下限 ${opts.minWeight}`);
    if (opts.lockedCut !== null && g.start < opts.lockedCut && g.end >= opts.lockedCut) {
      fail(`${tag}: 组 ${i} 跨越锁定切点 ${opts.lockedCut}`);
    }
    if (i > 0 && groups[i - 1].rate > g.rate + 1e-9) {
      fail(`${tag}: 组 ${i - 1} 与 ${i} 缺陷率不满足单调不降`);
    }
  }
  if (covered !== scores.length) fail(`${tag}: 未覆盖全部评分（${covered}/${scores.length}）`);
  const sumLoss = groups.reduce((a, g) => a + g.loss, 0);
  if (Math.abs(sumLoss - sol.loss) > 1e-7 * Math.max(1, Math.abs(sol.loss))) {
    fail(`${tag}: 报告损失 ${sol.loss} 与分组损失和 ${sumLoss} 不一致`);
  }
}

/* ---------- 汇总 ---------- */
console.log(`随机对照：${checked} 例可行（其中锁定边界 ${lockedCases} 例），${infeasibleBoth} 例双方一致判不可行`);
if (failures === 0) {
  console.log(`全部通过：${TRIALS} 组随机小样本 DP 与穷举一致，单元检查通过。`);
} else {
  console.error(`共 ${failures} 处失败`);
  process.exit(1);
}
