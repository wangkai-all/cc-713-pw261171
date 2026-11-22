/* app.js —— 设备质检风险评分分箱分析页（依赖 binning-core.js，无其他依赖） */
/* global BinningCore */
(function () {
  'use strict';
  const BC = BinningCore;
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';

  /* ---------------- 状态 ---------------- */
  const state = {
    rows: [],
    evalBatches: new Set(),
    minWeight: 120,
    maxGroups: 6,
    lockedBoundary: null, // 数值或 null
    selected: null,       // 选中的组下标
    result: null,         // compute() 的输出
  };

  /* ---------------- 格式化 ---------------- */
  const fmtPct = (x, d) => (x * 100).toFixed(d === undefined ? 1 : d) + '%';
  const fmtNum = (x) => {
    if (!Number.isFinite(x)) return '—';
    if (Math.abs(x) >= 1000) return Math.round(x).toLocaleString('en-US');
    if (Number.isInteger(x)) return String(x);
    return (Math.round(x * 10) / 10).toString();
  };
  const fmtLoss = (x) => (Math.abs(x) >= 100 ? x.toFixed(2) : x.toFixed(4));
  const fmtSigned = (x) => (x >= 0 ? '+' : '') + fmtLoss(x);

  /* ---------------- 主计算 ---------------- */
  function compute() {
    const rows = state.rows;
    const res = {
      ok: false, messages: [], trainAgg: null, evalAgg: null,
      unlocked: null, locked: null, chosen: null, cuts: [],
      evalPerGroup: [], lockedCutIndex: null, lockedValid: true,
      batches: [...new Set(rows.map((r) => r.batch))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true })),
    };
    if (!rows.length) { res.messages.push({ level: 'bad', text: '尚未载入数据。' }); return res; }

    const trainRows = rows.filter((r) => !state.evalBatches.has(r.batch));
    const evalRows = rows.filter((r) => state.evalBatches.has(r.batch));
    if (!trainRows.length) {
      res.messages.push({ level: 'bad', text: '训练批次为空：请至少保留一个批次不参与评估。' });
      return res;
    }

    res.trainAgg = BC.aggregateScores(trainRows);
    res.evalAgg = BC.aggregateScores(evalRows);
    const scores = res.trainAgg.scores;
    const n = scores.length;
    res.nDistinct = n;
    if (n === 0) {
      res.messages.push({ level: 'bad', text: '训练批次中没有可用的数值评分（全部缺失），无法分箱。' });
      return res;
    }

    // 锁定边界 -> 切点下标：c = 训练评分中 <= B 的个数，须为内部切点
    let lockedCut = null;
    if (state.lockedBoundary !== null) {
      const B = state.lockedBoundary;
      const c = scores.filter((s) => s.score <= B).length;
      if (c < 1 || c > n - 1) {
        res.lockedValid = false;
        res.messages.push({
          level: 'bad',
          text: '锁定边界 ' + B + ' 不在训练评分范围（' + scores[0].score + ' ~ ' + scores[n - 1].score + '）内部，无法形成切点。',
        });
      } else {
        lockedCut = c;
        res.lockedCutIndex = c;
      }
    }

    const opts = { minWeight: state.minWeight, maxGroups: state.maxGroups };
    res.unlocked = BC.optimalBinning(scores, opts);
    res.locked = lockedCut !== null ? BC.optimalBinning(scores, Object.assign({}, opts, { lockedCut })) : null;
    res.chosen = res.locked || res.unlocked;

    if (!res.chosen.feasible) {
      // 明确说明没有满足限制的切法，并给出原因
      if (!res.unlocked.feasible) {
        res.messages.push({
          level: 'bad',
          text: '没有满足限制的切法：训练评分总权重 ' + fmtNum(res.unlocked.totalWeight) +
            ' 低于每组最低样本权重 ' + fmtNum(state.minWeight) + '。请降低最低权重或检查数据。',
        });
      } else {
        const c = res.lockedCutIndex;
        const leftW = res.trainAgg.scores.slice(0, c).reduce((a, s) => a + s.w, 0);
        const rightW = res.unlocked.totalWeight - leftW;
        let why = '';
        if (leftW < state.minWeight || rightW < state.minWeight) {
          why = '边界左侧权重 ' + fmtNum(leftW) + '、右侧权重 ' + fmtNum(rightW) +
            '，至少一侧低于每组最低样本权重 ' + fmtNum(state.minWeight) + '。';
        } else if (state.maxGroups < 2) {
          why = '锁定边界至少需要 2 个组，但最大分组数为 ' + state.maxGroups + '。';
        } else {
          why = '边界两侧权重均达标，但无法同时满足缺陷率单调不降（左侧缺陷率整体高于右侧）。';
        }
        res.messages.push({
          level: 'bad',
          text: '锁定边界 ' + state.lockedBoundary + ' 后没有满足限制的切法。' + why,
        });
      }
      return res;
    }

    res.ok = true;
    res.cuts = BC.groupBoundaries(res.chosen.groups);

    // 评估样本按固定切点落组（左闭右开）
    const G = res.chosen.groups.length;
    res.evalPerGroup = [];
    for (let i = 0; i < G; i++) res.evalPerGroup.push({ n: 0, w: 0, d: 0, defects: 0 });
    for (const r of evalRows) {
      if (r.score === null || r.score === undefined || Number.isNaN(r.score)) continue;
      const g = BC.assignGroup(res.cuts, r.score);
      const e = res.evalPerGroup[g];
      e.n += 1; e.w += r.weight; e.d += r.defect * r.weight; e.defects += r.defect;
    }
    return res;
  }

  /* ---------------- 稳定性检查 ---------------- */
  function groupFlags(res, i) {
    const g = res.chosen.groups[i];
    const e = res.evalPerGroup[i];
    const flags = [];
    const ci = BC.wilsonInterval(g.defectWeight, g.weight);
    if (g.weight < 1.5 * state.minWeight) flags.push({ level: 'warn', text: '权重接近下限' });
    if (ci && ci.half > 0.10) flags.push({ level: 'warn', text: '置信区间宽（±' + fmtPct(ci.half, 1) + '）' });
    if (state.evalBatches.size > 0) {
      if (!e || e.w === 0) flags.push({ level: 'bad', text: '评估集无样本' });
      else if (e.w < state.minWeight) flags.push({ level: 'warn', text: '评估样本少' });
    }
    return flags;
  }

  /* ---------------- 渲染：状态行 ---------------- */
  function renderStatus(res) {
    const el = $('statusLine');
    el.textContent = '';
    for (const m of res.messages) {
      const chip = document.createElement('span');
      chip.className = 'chip ' + (m.level === 'bad' ? 'bad' : 'warn');
      chip.textContent = (m.level === 'bad' ? '⛔ ' : '⚠ ') + m.text;
      el.appendChild(chip);
    }
    if (!res.ok) return;

    const G = res.chosen.groups.length;
    const mk = (text, cls) => {
      const s = document.createElement('span');
      s.className = cls || '';
      s.textContent = text;
      el.appendChild(s);
    };
    mk('✓ 存在满足限制的切法', 'chip ok');
    mk('共 ' + G + ' 组', 'big');
    mk('最优损失 ' + fmtLoss(res.chosen.loss) + '（组内加权平方误差）');

    if (res.locked) {
      const delta = res.locked.loss - res.unlocked.loss;
      const pct = res.unlocked.loss > 0 ? (100 * delta) / res.unlocked.loss : 0;
      const chip = document.createElement('span');
      chip.className = 'chip ' + (delta > 1e-9 ? 'warn' : 'ok');
      chip.textContent = delta > 1e-9
        ? '锁定边界 ' + state.lockedBoundary + '：损失 ' + fmtLoss(res.locked.loss) +
          '，比未锁定最优 ' + fmtLoss(res.unlocked.loss) + ' 增加 ' + fmtSigned(delta) +
          '（' + fmtSigned(Math.round(pct * 10) / 10) + '%）'
        : '锁定边界 ' + state.lockedBoundary + '：不增加损失（未锁定的最优解本就包含该边界）';
      el.appendChild(chip);
    }
    if (G === 1) {
      const s = document.createElement('span');
      s.className = 'muted';
      s.textContent = '单调约束下最优为单一分组：训练数据中缺陷率随评分上升的趋势不明显（或受权重限制）。';
      el.appendChild(s);
    }
    // 高分段稳定性提示
    const topFlags = groupFlags(res, G - 1);
    if (topFlags.length) {
      const chip = document.createElement('span');
      chip.className = 'chip warn';
      chip.textContent = '⚠ 高分段（第 ' + G + ' 组）' + topFlags.map((f) => f.text).join('、') +
        '：风险估计不稳定，请谨慎解读';
      el.appendChild(chip);
    }
    // 评估集单调性核对
    if (state.evalBatches.size > 0) {
      const rates = res.evalPerGroup.map((e) => (e.w > 0 ? e.d / e.w : null));
      for (let i = 1; i < rates.length; i++) {
        if (rates[i] !== null && rates[i - 1] !== null && rates[i] < rates[i - 1] - 1e-9) {
          const s = document.createElement('span');
          s.className = 'muted';
          s.textContent = '评估集缺陷率在第 ' + i + ' / ' + (i + 1) + ' 组间出现回落，小样本噪声常见，请结合置信区间判断。';
          el.appendChild(s);
          break;
        }
      }
    }
  }

  /* ---------------- 渲染：图表 ---------------- */
  function svgEl(tag, attrs) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  }

  function niceScale(maxV, target) {
    target = target || 4;
    if (!(maxV > 0)) maxV = 1;
    const raw = maxV / target;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    let step = 10 * mag;
    for (const c of [1, 2, 2.5, 5, 10]) {
      if (c * mag >= raw - 1e-12) { step = c * mag; break; }
    }
    const top = Math.ceil(maxV / step - 1e-9) * step;
    const ticks = [];
    for (let v = 0; v <= top + 1e-9; v += step) ticks.push(v);
    return { step, top, ticks };
  }

  function topBarPath(x, y, w, h, r) {
    r = Math.max(0, Math.min(r, w / 2, h));
    return 'M' + x + ',' + (y + h) +
      ' L' + x + ',' + (y + r) + ' Q' + x + ',' + y + ' ' + (x + r) + ',' + y +
      ' L' + (x + w - r) + ',' + y + ' Q' + (x + w) + ',' + y + ' ' + (x + w) + ',' + (y + r) +
      ' L' + (x + w) + ',' + (y + h) + ' Z';
  }

  function cssVar(name) {
    return getComputedStyle($('root')).getPropertyValue(name).trim();
  }

  // 成组柱状图：series = [{key, color, values:[...]}]，每组 1~2 根
  function renderGroupedBars(svg, cfg) {
    svg.textContent = '';
    const W = cfg.width, H = cfg.height;
    const m = { t: 16, r: 12, b: 34, l: 48 };
    const plotW = W - m.l - m.r, plotH = H - m.t - m.b;
    const G = cfg.groups.length;
    const scale = niceScale(cfg.yMax, 4);
    const y = (v) => m.t + plotH - (v / scale.top) * plotH;
    const base = y(0);
    const slot = plotW / G;

    // 网格与坐标轴
    for (const t of scale.ticks) {
      const yy = y(t);
      svg.appendChild(svgEl('line', {
        x1: m.l, x2: W - m.r, y1: yy, y2: yy,
        stroke: t === 0 ? cssVar('--axis') : cssVar('--grid'), 'stroke-width': 1,
      }));
      const lab = svgEl('text', {
        x: m.l - 7, y: yy + 4, 'text-anchor': 'end',
        'font-size': 11, fill: cssVar('--muted'),
      });
      lab.style.fontVariantNumeric = 'tabular-nums';
      lab.textContent = cfg.fmtTick(t);
      svg.appendChild(lab);
    }

    const nSer = cfg.series.length;
    const barW = Math.max(3, Math.min(20, (slot - 16) / nSer - 1));
    const pairW = barW * nSer + 2 * (nSer - 1);

    cfg.groups.forEach((grp, i) => {
      const cx = m.l + slot * (i + 0.5);
      const gEl = svgEl('g', { 'class': 'grp', tabindex: '0', role: 'button' });
      gEl.setAttribute('aria-label', cfg.ariaLabel(i));
      const dim = state.selected !== null && state.selected !== i;

      cfg.series.forEach((ser, si) => {
        const v = ser.values[i];
        if (v === null || v === undefined) return;
        const x = cx - pairW / 2 + si * (barW + 2);
        const h = Math.max(0, base - y(v));
        if (h <= 0) {
          // 零值：画 1px 基线标记，保证可见
          gEl.appendChild(svgEl('line', {
            x1: x, x2: x + barW, y1: base - 1, y2: base - 1,
            stroke: ser.color, 'stroke-width': 2, opacity: dim ? 0.45 : 1,
          }));
          return;
        }
        gEl.appendChild(svgEl('path', {
          d: topBarPath(x, y(v), barW, h, 4),
          fill: ser.color, opacity: dim ? 0.45 : 1,
        }));
      });

      // 命中区域（含 2px 间隔，远大于柱体本身）
      const hit = svgEl('rect', {
        'class': 'hit', x: m.l + slot * i, y: m.t, width: slot, height: plotH,
        fill: 'transparent', stroke: 'none',
      });
      gEl.appendChild(hit);

      // x 轴组标签
      const lab = svgEl('text', { 'font-size': 11, fill: cssVar('--muted') });
      lab.style.fontVariantNumeric = 'tabular-nums';
      lab.textContent = grp.label;
      if (slot < 64) {
        lab.setAttribute('x', cx); lab.setAttribute('y', H - 20);
        lab.setAttribute('text-anchor', 'end');
        lab.setAttribute('transform', 'rotate(-32 ' + cx + ' ' + (H - 20) + ')');
      } else {
        lab.setAttribute('x', cx); lab.setAttribute('y', H - 12);
        lab.setAttribute('text-anchor', 'middle');
      }
      gEl.appendChild(lab);

      gEl.addEventListener('pointermove', (ev) => cfg.onHover(i, ev.clientX, ev.clientY));
      gEl.addEventListener('pointerleave', hideTooltip);
      gEl.addEventListener('focus', () => {
        const r = gEl.getBoundingClientRect();
        cfg.onHover(i, r.left + r.width / 2, r.bottom);
      });
      gEl.addEventListener('blur', hideTooltip);
      gEl.addEventListener('click', () => selectGroup(i));
      gEl.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectGroup(i); }
      });
      svg.appendChild(gEl);
    });

    // 选择性直接标注：只标训练缺陷率最高的一组
    if (cfg.labelMax !== undefined && cfg.labelMax !== null) {
      const i = cfg.labelMax;
      const v = cfg.series[0].values[i];
      if (v !== null && v > 0) {
        const cx = m.l + slot * (i + 0.5);
        const t = svgEl('text', {
          x: cx, y: y(v) - 6, 'text-anchor': 'middle',
          'font-size': 12, 'font-weight': 600, fill: cssVar('--ink-2'),
        });
        t.style.fontVariantNumeric = 'tabular-nums';
        t.textContent = cfg.fmtTick(v);
        svg.appendChild(t);
      }
    }
  }

  function renderLegend(el) {
    el.textContent = '';
    const items = [
      ['--series-1', '训练批次'],
      ['--series-2', '评估批次'],
    ];
    for (const [cv, name] of items) {
      const s = document.createElement('span');
      const sw = document.createElement('span');
      sw.className = 'sw';
      sw.style.background = cssVar(cv);
      s.appendChild(sw);
      s.appendChild(document.createTextNode(name));
      el.appendChild(s);
    }
  }

  function renderCharts(res) {
    const rateSvg = $('rateChart'), weightSvg = $('weightChart');
    renderLegend($('rateLegend'));
    renderLegend($('weightLegend'));
    if (!res.ok) { rateSvg.textContent = ''; weightSvg.textContent = ''; return; }

    const groups = res.chosen.groups;
    const G = groups.length;
    const trainRates = groups.map((g) => g.rate);
    const evalRates = res.evalPerGroup.map((e) => (e.w > 0 ? e.d / e.w : null));
    const labels = groups.map((g) => g.lo + '–' + g.hi);

    let maxRate = 0.05;
    trainRates.forEach((r) => { maxRate = Math.max(maxRate, r); });
    evalRates.forEach((r) => { if (r !== null) maxRate = Math.max(maxRate, r); });

    let labelMax = 0;
    trainRates.forEach((r, i) => { if (r > trainRates[labelMax]) labelMax = i; });

    renderGroupedBars(rateSvg, {
      width: 760, height: 260, groups: labels.map((l) => ({ label: l })),
      yMax: maxRate * 1.12,
      fmtTick: (v) => fmtPct(v, v < 0.095 ? 1 : 0),
      series: [
        { color: cssVar('--series-1'), values: trainRates },
        { color: cssVar('--series-2'), values: evalRates },
      ],
      labelMax,
      ariaLabel: (i) => '第 ' + (i + 1) + ' 组，评分 ' + labels[i] +
        '，训练缺陷率 ' + fmtPct(trainRates[i]) +
        (evalRates[i] === null ? '，评估集无样本' : '，评估缺陷率 ' + fmtPct(evalRates[i])),
      onHover: (i, x, y) => showGroupTooltip(res, i, x, y, 'rate'),
    });

    const trainW = groups.map((g) => g.weight);
    const evalW = res.evalPerGroup.map((e) => e.w);
    let maxW = 1;
    trainW.forEach((w) => { maxW = Math.max(maxW, w); });
    evalW.forEach((w) => { maxW = Math.max(maxW, w); });

    renderGroupedBars(weightSvg, {
      width: 760, height: 190, groups: labels.map((l) => ({ label: l })),
      yMax: maxW * 1.1,
      fmtTick: (v) => fmtNum(v),
      series: [
        { color: cssVar('--series-1'), values: trainW },
        { color: cssVar('--series-2'), values: evalW },
      ],
      labelMax: null,
      ariaLabel: (i) => '第 ' + (i + 1) + ' 组，训练权重 ' + fmtNum(trainW[i]) +
        '，评估权重 ' + fmtNum(evalW[i]),
      onHover: (i, x, y) => showGroupTooltip(res, i, x, y, 'weight'),
    });
  }

  /* ---------------- 提示框 ---------------- */
  const tooltip = () => $('tooltip');

  function tipRow(color, name, val, sub) {
    const row = document.createElement('div');
    row.className = 't-row';
    const key = document.createElement('span');
    key.className = 't-key';
    key.style.background = color;
    const v = document.createElement('span');
    v.className = 't-val';
    v.textContent = val;
    const nm = document.createElement('span');
    nm.className = 't-sub';
    nm.textContent = name + (sub ? ' · ' + sub : '');
    row.appendChild(key); row.appendChild(v); row.appendChild(nm);
    return row;
  }

  function showGroupTooltip(res, i, x, y, mode) {
    const g = res.chosen.groups[i];
    const e = res.evalPerGroup[i];
    const tip = tooltip();
    tip.textContent = '';
    const title = document.createElement('div');
    title.className = 't-title';
    title.textContent = '第 ' + (i + 1) + ' 组 · 评分 ' + g.lo + '–' + g.hi;
    tip.appendChild(title);
    if (mode === 'rate') {
      tip.appendChild(tipRow(cssVar('--series-1'), '训练', fmtPct(g.rate),
        '权重 ' + fmtNum(g.weight) + ' · 缺陷 ' + g.defects));
      tip.appendChild(tipRow(cssVar('--series-2'), '评估',
        e.w > 0 ? fmtPct(e.d / e.w) : '—',
        e.w > 0 ? '权重 ' + fmtNum(e.w) + ' · 缺陷 ' + e.defects : '无样本'));
    } else {
      tip.appendChild(tipRow(cssVar('--series-1'), '训练权重', fmtNum(g.weight), '缺陷率 ' + fmtPct(g.rate)));
      tip.appendChild(tipRow(cssVar('--series-2'), '评估权重', fmtNum(e.w),
        e.w > 0 ? '缺陷率 ' + fmtPct(e.d / e.w) : '无样本'));
    }
    tip.hidden = false;
    const pad = 12;
    const rect = tip.getBoundingClientRect();
    let left = x + pad, top = y + pad;
    if (left + rect.width > window.innerWidth - 8) left = x - rect.width - pad;
    if (top + rect.height > window.innerHeight - 8) top = y - rect.height - pad;
    tip.style.left = Math.max(4, left) + 'px';
    tip.style.top = Math.max(4, top) + 'px';
  }

  function hideTooltip() { tooltip().hidden = true; }

  /* ---------------- 渲染：表格 ---------------- */
  function renderTable(res) {
    const tbody = $('groupTable').querySelector('tbody');
    tbody.textContent = '';
    if (!res.ok) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 10;
      td.textContent = '无可展示的分组结果。';
      tr.appendChild(td);
      tbody.appendChild(tr);
      return;
    }
    const groups = res.chosen.groups;
    groups.forEach((g, i) => {
      const e = res.evalPerGroup[i];
      const ci = BC.wilsonInterval(g.defectWeight, g.weight);
      const tr = document.createElement('tr');
      tr.className = 'clickable' + (state.selected === i ? ' selected' : '');
      tr.tabIndex = 0;
      const cells = [
        '第 ' + (i + 1) + ' 组',
        g.lo + ' – ' + g.hi,
        intervalText(res, i),
        fmtNum(g.weight),
        fmtPct(g.rate),
        ci ? fmtPct(ci.lo) + ' ~ ' + fmtPct(ci.hi) : '—',
        e.w > 0 ? fmtNum(e.w) : '—',
        e.w > 0 ? fmtPct(e.d / e.w) : '—',
        String(batchSet(res, i).size) + ' 个',
      ];
      cells.forEach((c, ci2) => {
        const td = document.createElement('td');
        if (ci2 > 0) td.className = 'num';
        td.textContent = c;
        tr.appendChild(td);
      });
      const tdFlags = document.createElement('td');
      const flags = groupFlags(res, i);
      tdFlags.textContent = flags.length ? flags.map((f) => '⚠ ' + f.text).join('；') : '—';
      tr.appendChild(tdFlags);
      tr.addEventListener('click', () => selectGroup(i));
      tr.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); selectGroup(i); }
      });
      tbody.appendChild(tr);
    });
    // 缺失评分：单独一行，不参与数值顺序
    const mt = res.trainAgg.missing, me = res.evalAgg.missing;
    if (mt.n + me.n > 0) {
      const tr = document.createElement('tr');
      tr.className = 'missing-row';
      const cells = [
        '缺失评分（不参与分箱）', '—', '—',
        fmtNum(mt.w),
        mt.w > 0 ? fmtPct(mt.d / mt.w) : '—',
        '—',
        me.w > 0 ? fmtNum(me.w) : '—',
        me.w > 0 ? fmtPct(me.d / me.w) : '—',
        '—', '单独统计',
      ];
      cells.forEach((c, i) => {
        const td = document.createElement('td');
        if (i > 0) td.className = 'num';
        td.textContent = c;
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    }
  }

  function intervalText(res, i) {
    const cuts = res.cuts;
    const lo = i === 0 ? '-∞' : fmtNum(cuts[i - 1]);
    const hi = i === res.chosen.groups.length - 1 ? '+∞' : fmtNum(cuts[i]);
    return '[' + lo + ', ' + hi + ')';
  }

  function batchSet(res, i) {
    const g = res.chosen.groups[i];
    const set = new Set();
    for (const r of state.rows) {
      if (r.score === null || r.score === undefined || Number.isNaN(r.score)) continue;
      if (!state.evalBatches.has(r.batch)) {
        if (r.score >= g.lo && r.score <= g.hi) set.add(r.batch);
      } else {
        if (BC.assignGroup(res.cuts, r.score) === i) set.add(r.batch);
      }
    }
    return set;
  }

  /* ---------------- 渲染：组详情 ---------------- */
  function renderDetail(res) {
    const el = $('groupDetail');
    el.textContent = '';
    if (!res.ok || state.selected === null) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = res.ok ? '点击图表或表格中的某一组查看明细。' : '无可查看的分组。';
      el.appendChild(p);
      return;
    }
    const i = state.selected;
    const g = res.chosen.groups[i];
    const e = res.evalPerGroup[i];
    const ci = BC.wilsonInterval(g.defectWeight, g.weight);
    const ciE = e.w > 0 ? BC.wilsonInterval(e.d, e.w) : null;

    const h = document.createElement('p');
    h.innerHTML = '';
    const strong = document.createElement('strong');
    strong.textContent = '第 ' + (i + 1) + ' 组';
    h.appendChild(strong);
    h.appendChild(document.createTextNode(
      ' · 训练评分 ' + g.lo + ' – ' + g.hi + ' · 落组区间 ' + intervalText(res, i) + '（左闭右开）'));
    el.appendChild(h);

    const grid = document.createElement('div');
    grid.className = 'stat-grid';
    const tiles = [
      ['训练权重', fmtNum(g.weight), '样本 ' + countInGroup(res, i, true) + ' 行'],
      ['训练真实缺陷', String(defectsInGroup(res, i, true)) + ' 台', '加权 ' + fmtNum(g.defectWeight)],
      ['训练缺陷率', fmtPct(g.rate), ci ? '95% 区间 ' + fmtPct(ci.lo) + ' ~ ' + fmtPct(ci.hi) : ''],
      ['评估权重', e.w > 0 ? fmtNum(e.w) : '—', '样本 ' + e.n + ' 行'],
      ['评估真实缺陷', e.w > 0 ? e.defects + ' 台' : '—', e.w > 0 ? '加权 ' + fmtNum(e.d) : ''],
      ['评估缺陷率', e.w > 0 ? fmtPct(e.d / e.w) : '—', ciE ? '95% 区间 ' + fmtPct(ciE.lo) + ' ~ ' + fmtPct(ciE.hi) : ''],
    ];
    for (const [k, v, s] of tiles) {
      const d = document.createElement('div');
      d.className = 'stat';
      const dk = document.createElement('div'); dk.className = 'k'; dk.textContent = k;
      const dv = document.createElement('div'); dv.className = 'v'; dv.textContent = v;
      const ds = document.createElement('div'); ds.className = 's'; ds.textContent = s || ' ';
      d.appendChild(dk); d.appendChild(dv); d.appendChild(ds);
      grid.appendChild(d);
    }
    el.appendChild(grid);

    const flags = groupFlags(res, i);
    if (flags.length) {
      const row = document.createElement('div');
      row.className = 'row';
      for (const f of flags) {
        const chip = document.createElement('span');
        chip.className = 'chip ' + (f.level === 'bad' ? 'bad' : 'warn');
        chip.textContent = (f.level === 'bad' ? '⛔ ' : '⚠ ') + f.text;
        row.appendChild(chip);
      }
      el.appendChild(row);
    }

    // 来源批次明细
    const tbl = document.createElement('table');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    ['批次', '训练样本', '训练权重', '训练缺陷', '评估样本', '评估权重', '评估缺陷'].forEach((t, idx) => {
      const th = document.createElement('th');
      if (idx > 0) th.className = 'num';
      th.textContent = t;
      hr.appendChild(th);
    });
    thead.appendChild(hr);
    tbl.appendChild(thead);
    const tb = document.createElement('tbody');
    const perBatch = new Map();
    for (const r of state.rows) {
      if (r.score === null || r.score === undefined || Number.isNaN(r.score)) continue;
      const isEval = state.evalBatches.has(r.batch);
      const inGroup = isEval
        ? BC.assignGroup(res.cuts, r.score) === i
        : (r.score >= g.lo && r.score <= g.hi);
      if (!inGroup) continue;
      let b = perBatch.get(r.batch);
      if (!b) { b = { tn: 0, tw: 0, td: 0, en: 0, ew: 0, ed: 0 }; perBatch.set(r.batch, b); }
      if (isEval) { b.en++; b.ew += r.weight; b.ed += r.defect; }
      else { b.tn++; b.tw += r.weight; b.td += r.defect; }
    }
    const names = [...perBatch.keys()].sort((a, b2) => a.localeCompare(b2, 'zh-Hans-CN', { numeric: true }));
    for (const name of names) {
      const b = perBatch.get(name);
      const tr = document.createElement('tr');
      [name, b.tn, fmtNum(b.tw), b.td, b.en, fmtNum(b.ew), b.ed].forEach((val, idx) => {
        const td = document.createElement('td');
        if (idx > 0) td.className = 'num';
        td.textContent = String(val);
        tr.appendChild(td);
      });
      tb.appendChild(tr);
    }
    tbl.appendChild(tb);
    const cap = document.createElement('p');
    cap.className = 'muted';
    cap.textContent = '来源批次（缺陷为真实台数，未加权）：';
    el.appendChild(cap);
    el.appendChild(tbl);
  }

  function countInGroup(res, i, train) {
    const g = res.chosen.groups[i];
    let n = 0;
    for (const r of state.rows) {
      if (r.score === null || r.score === undefined || Number.isNaN(r.score)) continue;
      const isEval = state.evalBatches.has(r.batch);
      if (train && !isEval && r.score >= g.lo && r.score <= g.hi) n++;
    }
    return n;
  }

  function defectsInGroup(res, i, train) {
    const g = res.chosen.groups[i];
    let n = 0;
    for (const r of state.rows) {
      if (r.score === null || r.score === undefined || Number.isNaN(r.score)) continue;
      const isEval = state.evalBatches.has(r.batch);
      if (train && !isEval && r.score >= g.lo && r.score <= g.hi) n += r.defect;
    }
    return n;
  }

  /* ---------------- 渲染：数据卡片 ---------------- */
  function renderDataCard(res) {
    const rows = state.rows;
    const sum = $('dataSummary');
    sum.textContent = '';
    if (!rows.length) { sum.textContent = '尚未载入数据。'; $('batchRow').hidden = true; $('missingCard').textContent = ''; return; }

    const totalW = rows.reduce((a, r) => a + r.weight, 0);
    const miss = rows.filter((r) => r.score === null || Number.isNaN(r.score)).length;
    const distinct = new Set(rows.filter((r) => r.score !== null && !Number.isNaN(r.score)).map((r) => r.score)).size;
    let text = '共 ' + rows.length + ' 行 · ' + distinct + ' 个不同评分 · ' + res.batches.length +
      ' 个批次 · 总权重 ' + fmtNum(totalW) + ' · 缺失评分 ' + miss + ' 行';
    if (distinct > 40) text += '（不同评分超过演示规模 40，动态规划复杂度随其立方增长，可能稍慢）';
    sum.textContent = text;

    // 批次勾选
    $('batchRow').hidden = false;
    const box = $('batchChecks');
    box.textContent = '';
    for (const b of res.batches) {
      const lab = document.createElement('label');
      lab.className = 'chip';
      lab.style.cursor = 'pointer';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = state.evalBatches.has(b);
      cb.addEventListener('change', () => {
        if (cb.checked) state.evalBatches.add(b); else state.evalBatches.delete(b);
        recompute();
      });
      lab.appendChild(cb);
      lab.appendChild(document.createTextNode(' ' + b));
      box.appendChild(lab);
    }

    // 缺失评分单独统计
    const mc = $('missingCard');
    mc.textContent = '';
    if (res.trainAgg) {
      const mt = res.trainAgg.missing, me = res.evalAgg ? res.evalAgg.missing : { n: 0, w: 0, d: 0, defects: 0 };
      if (mt.n + me.n > 0) {
        const div = document.createElement('div');
        div.className = 'missing-box';
        div.textContent = '缺失评分（单独统计，不参与数值顺序与分箱）：训练 ' + mt.n + ' 行 · 权重 ' + fmtNum(mt.w) +
          ' · 真实缺陷 ' + mt.defects + ' 台' + (mt.w > 0 ? '（' + fmtPct(mt.d / mt.w) + '）' : '') +
          '；评估 ' + me.n + ' 行 · 权重 ' + fmtNum(me.w) + ' · 真实缺陷 ' + me.defects + ' 台' +
          (me.w > 0 ? '（' + fmtPct(me.d / me.w) + '）' : '');
        mc.appendChild(div);
      }
    }
  }

  /* ---------------- 总渲染 ---------------- */
  function recompute() {
    state.minWeight = Math.max(0, Number($('minWeight').value) || 0);
    state.maxGroups = Math.max(1, Math.min(12, Number($('maxGroups').value) || 1));
    const lv = $('lockedBoundary').value;
    state.lockedBoundary = lv === '' ? null : Number(lv);
    if (state.lockedBoundary !== null && !Number.isFinite(state.lockedBoundary)) state.lockedBoundary = null;

    const res = compute();
    state.result = res;
    if (state.selected !== null && (!res.ok || state.selected >= res.chosen.groups.length)) {
      state.selected = null;
    }
    renderDataCard(res);
    renderStatus(res);
    renderCharts(res);
    renderTable(res);
    renderDetail(res);
  }

  function selectGroup(i) {
    state.selected = state.selected === i ? null : i;
    renderCharts(state.result);
    renderTable(state.result);
    renderDetail(state.result);
  }

  /* ---------------- 数据载入 ---------------- */
  function setRows(rows, defaultEvalLast) {
    state.rows = rows;
    state.selected = null;
    const batches = [...new Set(rows.map((r) => r.batch))].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN', { numeric: true }));
    state.evalBatches = new Set();
    if (defaultEvalLast && batches.length > 1) state.evalBatches.add(batches[batches.length - 1]);
    recompute();
  }

  function showImportMsgs(parsed) {
    const el = $('importMsgs');
    el.textContent = '';
    if (parsed.warnings && parsed.warnings.length) {
      const ul = document.createElement('ul');
      ul.className = 'warn-list';
      for (const w of parsed.warnings) {
        const li = document.createElement('li');
        li.textContent = w;
        ul.appendChild(li);
      }
      el.appendChild(ul);
    }
    if (parsed.errors && parsed.errors.length) {
      const ul = document.createElement('ul');
      ul.className = 'err-list';
      for (const e of parsed.errors.slice(0, 20)) {
        const li = document.createElement('li');
        li.textContent = '第 ' + e.line + ' 行：' + e.reason;
        ul.appendChild(li);
      }
      el.appendChild(ul);
    }
  }

  function importText(text) {
    const parsed = BC.parseCSV(text);
    showImportMsgs(parsed);
    if (parsed.rows.length) setRows(parsed.rows, true);
    else recompute();
  }

  /* ---------------- 自测：小样本穷举核对 ---------------- */
  function runSelfTest() {
    const out = $('selfTestResult');
    out.textContent = '运行中……';
    // 让出一帧，避免按钮看似卡死
    setTimeout(() => {
      const rand = BC._internals.mulberry32((Date.now() % 2147483647) | 1);
      const TRIALS = 300;
      let checked = 0, infeasible = 0, locked = 0;
      const failures = [];
      for (let t = 0; t < TRIALS; t++) {
        const n = 2 + Math.floor(rand() * 10);
        const scores = [];
        for (let i = 0; i < n; i++) {
          const w = 1 + Math.floor(rand() * 6);
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
        if (opts.lockedCut !== null) locked++;
        const dp = BC.optimalBinning(scores, opts);
        const bf = BC.bruteForceBinning(scores, opts);
        if (dp.feasible !== bf.feasible) {
          failures.push('第 ' + t + ' 例可行性不一致');
          continue;
        }
        if (!dp.feasible) { infeasible++; continue; }
        const tol = 1e-7 * Math.max(1, Math.abs(bf.loss));
        if (Math.abs(dp.loss - bf.loss) > tol) {
          failures.push('第 ' + t + ' 例损失不一致：DP ' + dp.loss + ' vs 穷举 ' + bf.loss);
          continue;
        }
        checked++;
      }
      if (failures.length) {
        out.textContent = '✗ ' + failures.length + ' 处不一致：' + failures.slice(0, 3).join('；');
        out.style.color = cssVar('--critical');
      } else {
        out.textContent = '✓ 通过 ' + TRIALS + ' 组随机小样本核对（可行 ' + checked +
          ' 例，双方一致判不可行 ' + infeasible + ' 例，含锁定边界 ' + locked + ' 例）：动态规划与穷举结果一致。';
        out.style.color = cssVar('--success-text');
      }
    }, 30);
  }

  /* ---------------- 主题 ---------------- */
  function applyTheme(theme) {
    const root = document.documentElement;
    if (theme) root.setAttribute('data-theme', theme);
    else root.removeAttribute('data-theme');
    $('themeToggle').textContent =
      (theme === 'dark' || (!theme && window.matchMedia('(prefers-color-scheme: dark)').matches))
        ? '浅色模式' : '深色模式';
    if (state.result) recompute(); // 颜色来自 CSS 变量，重绘图表
  }

  /* ---------------- 事件绑定 ---------------- */
  function init() {
    $('loadDemo').addEventListener('click', () => {
      $('importMsgs').textContent = '';
      setRows(BC.makeDemoData().rows, true);
    });
    $('fileInput').addEventListener('change', (ev) => {
      const f = ev.target.files && ev.target.files[0];
      if (!f) return;
      const reader = new FileReader();
      reader.onload = () => importText(String(reader.result));
      reader.readAsText(f);
      ev.target.value = '';
    });
    $('parsePaste').addEventListener('click', () => {
      const t = $('pasteArea').value.trim();
      if (t) importText(t);
    });
    $('downloadTemplate').addEventListener('click', () => {
      const csv = 'score,defect,weight,batch\n72.5,1,2,P2601\n68.1,0,1,P2601\n,0,1,P2602\n';
      const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'risk-score-template.csv';
      a.click();
      URL.revokeObjectURL(a.href);
    });
    for (const id of ['minWeight', 'maxGroups', 'lockedBoundary']) {
      $(id).addEventListener('change', recompute);
    }
    $('clearLock').addEventListener('click', () => { $('lockedBoundary').value = ''; recompute(); });
    $('runSelfTest').addEventListener('click', runSelfTest);
    $('themeToggle').addEventListener('click', () => {
      const cur = document.documentElement.getAttribute('data-theme');
      const next = cur === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem('rk-theme', next); } catch (e) { /* 忽略 */ }
      applyTheme(next);
    });
    document.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') { hideTooltip(); if (state.selected !== null) selectGroup(state.selected); }
    });

    let saved = null;
    try { saved = localStorage.getItem('rk-theme'); } catch (e) { /* 忽略 */ }
    applyTheme(saved);

    // 初始载入演示数据
    setRows(BC.makeDemoData().rows, true);
  }

  init();
})();
