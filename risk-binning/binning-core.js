/* binning-core.js
 * 设备质检 · 风险评分单调分箱 —— 核心算法（无 DOM 依赖）。
 *
 * 浏览器：<script src="binning-core.js"> 后使用 window.BinningCore
 * Node：  const BinningCore = require('./binning-core.js')
 *
 * 方法要点：
 *  - 相同评分先聚合，绝不拆到两个组；缺失评分单独统计，不参与数值顺序。
 *  - 约束：每组总权重 >= minWeight，组数 <= maxGroups，组缺陷率沿评分单调不降。
 *  - 目标：最小化整体损失 = 各组内"缺陷指示"相对组缺陷率的加权平方误差之和
 *    （行级加权 Brier 损失：loss(g) = D - D^2 / W）。
 *  - 求解：动态规划（状态 = 前 t 个评分、已用 g 组、末组恰为 [s..t]），全局最优，
 *    不是贪心相邻合并。bruteForceBinning 提供小样本穷举用于核对。
 *  - 锁定业务边界：禁止任何组跨越指定切点，等价于强制该处成为组边界。
 */
(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.BinningCore = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const EPS = 1e-9;

  /* ---------------- 聚合：相同评分合并，缺失单独统计 ---------------- */

  // rows: [{score: number|null, defect: 0|1, weight: number, batch: string}]
  // -> { scores: [{score, w, d, n, defects}] 按 score 升序, missing: {w,d,n,defects} }
  // w = 权重和；d = 加权缺陷（缺陷行权重和）；n = 行数；defects = 真实缺陷行数
  function aggregateScores(rows) {
    const map = new Map();
    const missing = { w: 0, d: 0, n: 0, defects: 0 };
    for (const r of rows) {
      const w = r.weight;
      const dw = r.defect * w;
      if (r.score === null || r.score === undefined || Number.isNaN(r.score)) {
        missing.w += w; missing.d += dw; missing.n += 1; missing.defects += r.defect;
        continue;
      }
      let e = map.get(r.score);
      if (!e) { e = { score: r.score, w: 0, d: 0, n: 0, defects: 0 }; map.set(r.score, e); }
      e.w += w; e.d += dw; e.n += 1; e.defects += r.defect;
    }
    const scores = [...map.values()].sort((a, b) => a.score - b.score);
    return { scores, missing };
  }

  /* ---------------- 前缀和与组统计 ---------------- */

  function prefixSums(scores) {
    const n = scores.length;
    const W = new Float64Array(n + 1);
    const D = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) {
      W[i + 1] = W[i] + scores[i].w;
      D[i + 1] = D[i] + scores[i].d;
    }
    return { n, W, D };
  }

  // 区间 [s, t]（含两端，0 起始）的统计量
  function intervalStat(P, s, t) {
    const W = P.W[t + 1] - P.W[s];
    const D = P.D[t + 1] - P.D[s];
    // 行级加权平方误差：sum w*(y - p)^2 = D - D^2/W
    let loss = W > 0 ? D - (D * D) / W : 0;
    if (loss < 0 && loss > -1e-9) loss = 0;
    return { W, D, mean: W > 0 ? D / W : 0, loss };
  }

  // 均值单调不降：D1/W1 <= D2/W2，交叉相乘避免除法误差
  function meanLE(D1, W1, D2, W2) {
    const lhs = D1 * W2, rhs = D2 * W1;
    return lhs <= rhs + 1e-9 * Math.max(1, Math.abs(lhs), Math.abs(rhs));
  }

  function intervalMeanLE(P, s1, t1, s2, t2) {
    return meanLE(
      P.D[t1 + 1] - P.D[s1], P.W[t1 + 1] - P.W[s1],
      P.D[t2 + 1] - P.D[s2], P.W[t2 + 1] - P.W[s2]
    );
  }

  function buildGroups(P, scores, intervals) {
    return intervals.map(([s, t]) => {
      const st = intervalStat(P, s, t);
      return {
        start: s, end: t,
        lo: scores[s].score, hi: scores[t].score,
        weight: st.W, defectWeight: st.D, rate: st.mean, loss: st.loss,
      };
    });
  }

  /* ---------------- 动态规划：全局最优单调分箱 ---------------- */

  // opts: { minWeight, maxGroups, lockedCut }
  // lockedCut: null 或整数 c ∈ [1, n-1]，表示第 c-1 与第 c 个评分之间必须是组边界
  //            （等价于禁止任何组跨越该切点）。
  // 返回 { feasible, reason?, loss?, groups?, n, totalWeight }
  function optimalBinning(scores, opts) {
    const o = opts || {};
    const minWeight = o.minWeight || 0;
    const maxGroups = Math.max(1, o.maxGroups || 8);
    const lockedCut = o.lockedCut === undefined ? null : o.lockedCut;

    const P = prefixSums(scores);
    const n = P.n;
    const totalWeight = P.W[n];
    if (n === 0) return { feasible: false, reason: 'empty', n, totalWeight };

    // 可行区间表：权重达标，且不跨越锁定切点
    const ok = [];
    const lossM = [];
    for (let s = 0; s < n; s++) {
      ok.push(new Uint8Array(n));
      lossM.push(new Float64Array(n));
      for (let t = s; t < n; t++) {
        const st = intervalStat(P, s, t);
        lossM[s][t] = st.loss;
        let feasible = st.W >= minWeight - EPS;
        if (lockedCut !== null && s < lockedCut && t >= lockedCut) feasible = false;
        ok[s][t] = feasible ? 1 : 0;
      }
    }

    const G = Math.min(maxGroups, n);
    const INF = Infinity;
    // dp[g][s][t]：把 [0..t] 分成 g 组、末组恰为 [s..t] 的最小总损失
    const dp = [];
    const parent = [];
    for (let g = 0; g <= G; g++) {
      const m = [], pm = [];
      for (let s = 0; s < n; s++) {
        m.push(new Float64Array(n).fill(INF));
        pm.push(new Int32Array(n).fill(-1));
      }
      dp.push(m); parent.push(pm);
    }
    for (let t = 0; t < n; t++) {
      if (ok[0][t]) { dp[1][0][t] = lossM[0][t]; }
    }
    for (let g = 2; g <= G; g++) {
      for (let s = 1; s < n; s++) {
        for (let t = s; t < n; t++) {
          if (!ok[s][t]) continue;
          let best = INF, bs = -1;
          for (let sp = 0; sp <= s - 1; sp++) {
            const prev = dp[g - 1][sp][s - 1];
            if (prev === INF) continue;
            if (!intervalMeanLE(P, sp, s - 1, s, t)) continue; // 单调不降
            if (prev < best) { best = prev; bs = sp; }
          }
          if (bs >= 0) {
            dp[g][s][t] = best + lossM[s][t];
            parent[g][s][t] = bs;
          }
        }
      }
    }

    // 组数 1..G 中取损失最小；并列时偏向更少组（解释更简单）
    let bestLoss = INF, bestG = -1, bestS = -1;
    for (let g = 1; g <= G; g++) {
      for (let s = 0; s < n; s++) {
        const v = dp[g][s][n - 1];
        if (v < bestLoss - 1e-9) { bestLoss = v; bestG = g; bestS = s; }
      }
    }
    if (bestG < 0) return { feasible: false, reason: 'constraints', n, totalWeight };

    const intervals = [];
    let g = bestG, s = bestS, t = n - 1;
    while (g >= 1) {
      intervals.push([s, t]);
      const sp = parent[g][s][t];
      t = s - 1; s = sp; g--;
    }
    intervals.reverse();

    return {
      feasible: true, n, totalWeight,
      loss: bestLoss,
      groups: buildGroups(P, scores, intervals),
    };
  }

  /* ---------------- 小样本穷举（仅用于核对 DP） ---------------- */

  // 与 optimalBinning 同参数；枚举全部 2^(n-1) 种切分，逐一检查约束取最优。
  // 仅适合 n <= 24。
  function bruteForceBinning(scores, opts) {
    const o = opts || {};
    const minWeight = o.minWeight || 0;
    const maxGroups = Math.max(1, o.maxGroups || 8);
    const lockedCut = o.lockedCut === undefined ? null : o.lockedCut;

    const P = prefixSums(scores);
    const n = P.n;
    const totalWeight = P.W[n];
    if (n === 0) return { feasible: false, reason: 'empty', n, totalWeight };
    if (n > 24) throw new Error('bruteForceBinning 仅支持 n <= 24');

    let best = Infinity, bestMask = -1;
    const m = n - 1;
    const total = 1 << m;
    for (let mask = 0; mask < total; mask++) {
      const groups = (mask === 0) ? 1 : (popcount(mask) + 1);
      if (groups > maxGroups) continue;
      if (lockedCut !== null && !(mask & (1 << (lockedCut - 1)))) continue;

      let feasible = true, lossSum = 0;
      let prevD = 0, prevW = 0, prevSet = false;
      let start = 0;
      for (let i = 0; i <= m; i++) {
        const isEnd = (i === m) || (mask & (1 << i));
        if (!isEnd) continue;
        const st = intervalStat(P, start, i);
        if (st.W < minWeight - EPS) { feasible = false; break; }
        if (prevSet && !meanLE(prevD, prevW, st.D, st.W)) { feasible = false; break; }
        prevD = st.D; prevW = st.W; prevSet = true;
        lossSum += st.loss;
        start = i + 1;
      }
      if (!feasible) continue;
      if (lossSum < best - 1e-9) { best = lossSum; bestMask = mask; }
    }
    if (bestMask < 0) return { feasible: false, reason: 'constraints', n, totalWeight };

    const intervals = [];
    let start = 0;
    for (let i = 0; i <= m; i++) {
      const isEnd = (i === m) || (bestMask & (1 << i));
      if (!isEnd) continue;
      intervals.push([start, i]);
      start = i + 1;
    }
    return {
      feasible: true, n, totalWeight,
      loss: best,
      groups: buildGroups(P, scores, intervals),
    };
  }

  function popcount(x) {
    let c = 0;
    while (x) { x &= x - 1; c++; }
    return c;
  }

  /* ---------------- 落组约定：切点 + 左闭右开 ---------------- */

  // 相邻组的切点 = 训练评分的中点；组 g 的落组区间为 [cuts[g-1], cuts[g])，
  // 左闭右开；首组左端 -Infinity，末组右端 +Infinity。
  function groupBoundaries(groups) {
    const cuts = [];
    for (let i = 0; i < groups.length - 1; i++) {
      cuts.push((groups[i].hi + groups[i + 1].lo) / 2);
    }
    return cuts;
  }

  // x 落入的组下标：cuts[g-1] <= x < cuts[g]
  function assignGroup(cuts, x) {
    let g = 0;
    while (g < cuts.length && x >= cuts[g]) g++;
    return g;
  }

  /* ---------------- Wilson 置信区间（按权重折算的近似） ---------------- */

  function wilsonInterval(k, n, z) {
    z = z || 1.959963984540054;
    if (!(n > 0)) return null;
    const p = k / n, z2 = z * z;
    const denom = 1 + z2 / n;
    const center = (p + z2 / (2 * n)) / denom;
    const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom;
    return { lo: Math.max(0, center - half), hi: Math.min(1, center + half), half };
  }

  /* ---------------- CSV 解析 ---------------- */

  const MISSING_TOKENS = new Set(['', 'na', 'n/a', 'null', 'none', 'nan', '缺失', '未知', '-', '--']);
  const DEFECT_TOKENS = new Map([
    ['1', 1], ['0', 0],
    ['是', 1], ['否', 0],
    ['true', 1], ['false', 0],
    ['y', 1], ['n', 0], ['yes', 1], ['no', 0],
    ['发现缺陷', 1], ['未发现', 0], ['有', 1], ['无', 0],
  ]);
  const HEADER_KEYS = {
    score: ['score', '评分', '分值', '风险评分', '得分', 'points', 'point'],
    defect: ['defect', '缺陷', '是否发现缺陷', '发现缺陷', '不良', 'isdefect', 'defective', 'label'],
    weight: ['weight', '权重', '样本权重', 'w', 'sampleweight'],
    batch: ['batch', '批次', '生产批次', 'lot', '批号'],
  };

  function normalizeHeader(s) {
    return String(s).toLowerCase().replace(/[\s_\-（）()]/g, '');
  }

  function splitCSVLine(line, delim) {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (inQ) {
        if (ch === '"') {
          if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false;
        } else cur += ch;
      } else if (ch === '"') inQ = true;
      else if (ch === delim) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    out.push(cur);
    return out.map((s) => s.trim());
  }

  function detectDelimiter(line) {
    let best = ',', bestCount = 0;
    for (const d of ['\t', ';', ',']) {
      const c = line.split(d).length - 1;
      if (c > bestCount) { bestCount = c; best = d; }
    }
    return best;
  }

  // -> { rows, errors, warnings, headers }
  // rows: [{score:number|null, defect:0|1, weight:number, batch:string}]
  function parseCSV(text) {
    const errors = [], warnings = [], rows = [];
    const lines = String(text).replace(/^﻿/, '').split(/\r\n|\r|\n/)
      .filter((l) => l.trim().length > 0);
    if (lines.length === 0) {
      return { rows, errors: [{ line: 0, reason: '文件为空' }], warnings, headers: null };
    }
    const delim = detectDelimiter(lines[0]);
    const first = splitCSVLine(lines[0], delim);
    const norm = first.map(normalizeHeader);

    // 识别表头
    const colIndex = {};
    let headerFound = false;
    for (const [key, names] of Object.entries(HEADER_KEYS)) {
      for (const name of names) {
        const idx = norm.indexOf(normalizeHeader(name));
        if (idx >= 0) { colIndex[key] = idx; headerFound = true; break; }
      }
    }

    let startLine;
    if (headerFound) {
      startLine = 1;
      for (const key of ['score', 'defect', 'batch']) {
        if (colIndex[key] === undefined) {
          errors.push({ line: 1, reason: '表头缺少必需列：' + key });
        }
      }
      if (colIndex.weight === undefined) {
        warnings.push('未找到权重列，全部按权重 1 处理');
      }
      if (errors.length) return { rows, errors, warnings, headers: first };
    } else {
      // 无表头：按 score,defect,weight,batch 顺序
      if (first.length < 2) {
        return { rows, errors: [{ line: 1, reason: '无法识别表头，且列数不足' }], warnings, headers: null };
      }
      colIndex.score = 0; colIndex.defect = 1;
      if (first.length >= 3) colIndex.weight = 2;
      if (first.length >= 4) colIndex.batch = 3;
      startLine = 0;
      warnings.push('未识别到表头，按 score,defect,weight,batch 顺序解析');
    }

    for (let li = startLine; li < lines.length; li++) {
      const f = splitCSVLine(lines[li], delim);
      const lineNo = li + 1;
      const get = (k) => (colIndex[k] === undefined ? '' : (f[colIndex[k]] || ''));

      // 评分
      let score = null;
      const sRaw = get('score');
      if (!MISSING_TOKENS.has(sRaw.toLowerCase())) {
        const v = Number(sRaw);
        if (!Number.isFinite(v)) {
          errors.push({ line: lineNo, reason: '评分无法解析：' + sRaw });
          continue;
        }
        score = v;
      }
      // 缺陷
      const dRaw = get('defect').toLowerCase();
      if (!DEFECT_TOKENS.has(dRaw)) {
        errors.push({ line: lineNo, reason: '缺陷标记无法解析：' + get('defect') });
        continue;
      }
      const defect = DEFECT_TOKENS.get(dRaw);
      // 权重
      let weight = 1;
      const wRaw = get('weight');
      if (wRaw !== '') {
        const v = Number(wRaw);
        if (!Number.isFinite(v) || v <= 0) {
          errors.push({ line: lineNo, reason: '权重必须为正数：' + wRaw });
          continue;
        }
        weight = v;
      }
      // 批次
      const batch = get('batch') || '（未标注批次）';

      rows.push({ score, defect, weight, batch });
    }
    if (errors.length > 20) {
      const extra = errors.length - 20;
      errors.length = 20;
      errors.push({ line: -1, reason: '……另有 ' + extra + ' 行错误未列出' });
    }
    return { rows, errors, warnings, headers: headerFound ? first : null };
  }

  /* ---------------- 演示数据（<= 40 个不同评分） ---------------- */

  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  // 36 个不同评分、6 个生产批次；缺陷率随评分上升；高分段样本稀疏；
  // 约 2.5% 行缺失评分。确定性（固定种子），便于核对与演示。
  function makeDemoData(seed) {
    const rand = mulberry32(seed === undefined ? 20261122 : seed);

    const values = [];
    let v = 50 + rand() * 2;
    while (values.length < 36) {
      values.push(Math.round(v * 10) / 10);
      v += 0.7 + rand() * 1.9;
    }

    const batches = ['P2607', 'P2608', 'P2609', 'P2610', 'P2611', 'P2612'];
    const rows = [];
    for (let bi = 0; bi < batches.length; bi++) {
      const n = 78 + Math.floor(rand() * 30);
      for (let i = 0; i < n; i++) {
        // 评分分布向低分段倾斜，高分段稀疏
        let idx = Math.floor(36 * Math.pow(rand(), 1.7)) + Math.floor(bi * 0.5);
        idx = Math.max(0, Math.min(values.length - 1, idx));
        const score = values[idx];
        // 缺陷概率随评分上升（logistic），批次间略有差异
        const p = 0.02 + 0.38 / (1 + Math.exp(-(score - 74) / 6)) + (bi - 2.5) * 0.008;
        const defect = rand() < p ? 1 : 0;
        // 权重：多数 1~5，少数大权重
        let weight = 1 + Math.floor(Math.pow(rand(), 2) * 5);
        if (rand() < 0.04) weight = 10;
        // 少量缺失评分
        const missing = rand() < 0.025;
        rows.push({ score: missing ? null : score, defect, weight, batch: batches[bi] });
      }
    }
    return { rows, values, batches };
  }

  return {
    EPS,
    aggregateScores,
    optimalBinning,
    bruteForceBinning,
    groupBoundaries,
    assignGroup,
    wilsonInterval,
    parseCSV,
    makeDemoData,
    // 暴露给测试/核对
    _internals: { prefixSums, intervalStat, meanLE, intervalMeanLE, mulberry32 },
  };
});
