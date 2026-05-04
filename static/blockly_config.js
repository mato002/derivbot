/* global Blockly */
let builderWorkspace = null;
let builderSnapEnabled = true;
let builderToolboxConfig = null;

const BUILDER_TEMPLATE_LIBRARY = [
  { id: "martingale", label: "Martingale", group: "accumulators", threshold: 5, contract: "DIGITUNDER", logicMode: "AND", stake: 1, loss: 25, profit: 20, trend: "BULLISH", rsiOp: "LT", rsiValue: 35 },
  { id: "martingale_reset", label: "Martingale on Stat Reset", group: "accumulators", threshold: 5, contract: "DIGITUNDER", logicMode: "AND", stake: 1, loss: 25, profit: 20, trend: "SIDEWAYS", rsiOp: "LT", rsiValue: 40 },
  { id: "dalembert", label: "D'Alembert", group: "accumulators", threshold: 6, contract: "DIGITUNDER", logicMode: "OR", stake: 1.5, loss: 30, profit: 24, trend: "SIDEWAYS", rsiOp: "LT", rsiValue: 42 },
  { id: "dalembert_reset", label: "D'Alembert on Stat Reset", group: "accumulators", threshold: 6, contract: "DIGITUNDER", logicMode: "OR", stake: 1.5, loss: 30, profit: 24, trend: "SIDEWAYS", rsiOp: "LT", rsiValue: 45 },
  { id: "reverse_martingale", label: "Reverse Martingale", group: "accumulators", threshold: 4, contract: "DIGITOVER", logicMode: "AND", stake: 1, loss: 18, profit: 28, trend: "BULLISH", rsiOp: "GT", rsiValue: 65 },
  { id: "reverse_reset", label: "Reverse Martingale on Stat Reset", group: "accumulators", threshold: 4, contract: "DIGITOVER", logicMode: "AND", stake: 1, loss: 18, profit: 28, trend: "BULLISH", rsiOp: "GT", rsiValue: 60 },
  { id: "reverse_dalembert", label: "Reverse D'Alembert", group: "options", threshold: 4, contract: "DIGITOVER", logicMode: "OR", stake: 0.9, loss: 18, profit: 22, trend: "BULLISH", rsiOp: "GT", rsiValue: 57 },
  { id: "oscars_grind", label: "Oscar's Grind", group: "options", threshold: 5, contract: "DIGITUNDER", logicMode: "AND", stake: 0.75, loss: 16, profit: 18, trend: "SIDEWAYS", rsiOp: "LT", rsiValue: 44 },
  { id: "one_three_two_six", label: "1-3-2-6", group: "options", threshold: 6, contract: "DIGITOVER", logicMode: "AND", stake: 0.65, loss: 12, profit: 16, trend: "BULLISH", rsiOp: "GT", rsiValue: 61 },
  { id: "digit_breakout", label: "Digit Breakout", group: "options", threshold: 7, contract: "DIGITOVER", logicMode: "AND", stake: 0.85, loss: 14, profit: 18, trend: "BULLISH", rsiOp: "GT", rsiValue: 58 },
  { id: "mean_revert", label: "Mean Reversion", group: "options", threshold: 3, contract: "DIGITUNDER", logicMode: "OR", stake: 0.85, loss: 14, profit: 18, trend: "BEARISH", rsiOp: "LT", rsiValue: 32 },
];

const DEFAULT_STRATEGY = {
  type: "digit_strategy",
  condition: "repeat_3",
  action: "over_under",
  active_action: "over_under",
  actions: {
    over_under: {
      enabled: true,
      rules: {
        if_digit_greater_equal: 5,
        trade: "UNDER",
        else_trade: "OVER",
      },
    },
    rise_fall: {
      enabled: false,
      rules: {
        if_digit_greater_equal: 5,
        trade: "RISE",
        else_trade: "FALL",
      },
    },
  },
};

function createBuilderWorkspace() {
  const blocklyDiv = document.getElementById("blocklyDiv");
  if (!blocklyDiv || typeof Blockly === "undefined") {
    return null;
  }

  Blockly.defineBlocksWithJsonArray([
    {
      type: "repeat_3_condition",
      message0: "If last digit repeats 3 times",
      nextStatement: null,
      colour: 210,
      tooltip: "Trigger when last 3 digits are the same",
    },
    {
      type: "digit_threshold",
      message0: "If digit >= %1",
      args0: [{ type: "field_number", name: "THRESHOLD", value: 5, min: 0, max: 9 }],
      previousStatement: null,
      nextStatement: null,
      colour: 270,
      tooltip: "Threshold for branching trade side",
    },
    {
      type: "buy_under_action",
      message0: "Buy Under",
      previousStatement: null,
      nextStatement: null,
      colour: 120,
      tooltip: "Use DIGITUNDER when condition is true",
    },
    {
      type: "buy_over_action",
      message0: "Buy Over",
      previousStatement: null,
      nextStatement: null,
      colour: 120,
      tooltip: "Use DIGITOVER when condition is false",
    },
    {
      type: "logic_gate",
      message0: "Logic is %1",
      args0: [
        {
          type: "field_dropdown",
          name: "MODE",
          options: [
            ["AND", "AND"],
            ["OR", "OR"],
          ],
        },
      ],
      previousStatement: null,
      nextStatement: null,
      colour: 270,
      tooltip: "Logic gate to combine conditions",
    },
    {
      type: "analysis_trend",
      message0: "Trend %1",
      args0: [{ type: "field_dropdown", name: "TREND", options: [["Bullish", "BULLISH"], ["Bearish", "BEARISH"], ["Sideways", "SIDEWAYS"]] }],
      previousStatement: null,
      nextStatement: null,
      colour: 30,
      tooltip: "Use current trend context in your logic",
    },
    {
      type: "analysis_rsi",
      message0: "RSI %1 %2",
      args0: [
        { type: "field_dropdown", name: "OP", options: [["<", "LT"], [">", "GT"]] },
        { type: "field_number", name: "VALUE", value: 30, min: 0, max: 100 },
      ],
      previousStatement: null,
      nextStatement: null,
      colour: 30,
      tooltip: "Relative Strength Index check",
    },
    {
      type: "stake_config",
      message0: "Stake %1",
      args0: [{ type: "field_number", name: "STAKE", value: 1, min: 0.35 }],
      previousStatement: null,
      nextStatement: null,
      colour: 270,
      tooltip: "Base stake amount",
    },
    {
      type: "loss_limit",
      message0: "Loss threshold %1",
      args0: [{ type: "field_number", name: "LOSS", value: 25, min: 0 }],
      previousStatement: null,
      nextStatement: null,
      colour: 0,
      tooltip: "Stop after reaching loss threshold",
    },
    {
      type: "profit_limit",
      message0: "Profit threshold %1",
      args0: [{ type: "field_number", name: "PROFIT", value: 20, min: 0 }],
      previousStatement: null,
      nextStatement: null,
      colour: 120,
      tooltip: "Stop after reaching profit threshold",
    },
    {
      type: "restart_condition",
      message0: "Restart after stat reset",
      previousStatement: null,
      nextStatement: null,
      colour: 60,
      tooltip: "Resume strategy after stat reset",
    },
  ]);

  builderToolboxConfig = {
    kind: "categoryToolbox",
    contents: [
      {
        kind: "category",
        categorystyle: "logic_category",
        name: "Analysis Logics",
        colour: "30",
        contents: [
          { kind: "block", type: "analysis_trend" },
          { kind: "block", type: "analysis_rsi" },
          { kind: "block", type: "logic_gate" },
        ],
      },
      {
        kind: "category",
        name: "Trade parameters",
        colour: "270",
        contents: [
          { kind: "block", type: "stake_config" },
          { kind: "block", type: "digit_threshold" },
          { kind: "block", type: "profit_limit" },
        ],
      },
      {
        kind: "category",
        name: "Purchase conditions",
        colour: "210",
        contents: [{ kind: "block", type: "repeat_3_condition" }],
      },
      {
        kind: "category",
        name: "Sell conditions (optional)",
        colour: "0",
        contents: [
          { kind: "block", type: "loss_limit" },
          { kind: "block", type: "profit_limit" },
        ],
      },
      {
        kind: "category",
        name: "Restart trading conditions",
        colour: "60",
        contents: [{ kind: "block", type: "restart_condition" }],
      },
      {
        kind: "category",
        name: "Analysis",
        colour: "180",
        contents: [
          { kind: "block", type: "buy_under_action" },
          { kind: "block", type: "buy_over_action" },
        ],
      },
      {
        kind: "category",
        name: "Utility",
        colour: "290",
        contents: [{ kind: "block", type: "logic_gate" }],
      },
      {
        kind: "category",
        name: "Virtual Hook Switcher",
        colour: "320",
        contents: [{ kind: "block", type: "restart_condition" }],
      },
      {
        kind: "category",
        name: "Binarytools",
        colour: "20",
        contents: [{ kind: "block", type: "analysis_trend" }],
      },
      {
        kind: "category",
        name: "Contract modifiers",
        colour: "45",
        contents: [{ kind: "block", type: "stake_config" }],
      },
    ],
  };

  builderWorkspace = Blockly.inject("blocklyDiv", {
    toolbox: builderToolboxConfig,
    trashcan: true,
    zoom: { controls: true, wheel: true },
    move: { scrollbars: true, drag: true, wheel: true },
    grid: { spacing: 22, length: 2, colour: "#d7deeb", snap: true },
    renderer: "zelos",
  });

  builderWorkspace.addChangeListener(() => {
    validateBuilderBlocks();
    drawBuilderMiniMap();
  });

  window.addEventListener("resize", () => {
    if (builderWorkspace) Blockly.svgResize(builderWorkspace);
  });

  loadStrategyIntoWorkspace(DEFAULT_STRATEGY);
  window.requestAnimationFrame(() => {
    if (builderWorkspace) Blockly.svgResize(builderWorkspace);
    validateBuilderBlocks();
    drawBuilderMiniMap();
  });
  return builderWorkspace;
}

function setBuilderSnapToGrid(enabled) {
  builderSnapEnabled = !!enabled;
  if (!builderWorkspace) return;
  const opts = builderWorkspace.options || {};
  if (opts.gridOptions) {
    opts.gridOptions.snap = builderSnapEnabled;
  }
}

function cleanBuilderWorkspaceLayout() {
  if (!builderWorkspace) return;
  const blocks = builderWorkspace.getTopBlocks(true);
  const startX = 40;
  let y = 40;
  blocks.forEach((block) => {
    const h = block.getHeightWidth().height || 50;
    block.moveBy(startX - block.getRelativeToSurfaceXY().x, y - block.getRelativeToSurfaceXY().y);
    y += h + 24;
  });
  drawBuilderMiniMap();
}

function validateBuilderBlocks() {
  if (!builderWorkspace) return;
  const blocks = builderWorkspace.getAllBlocks(false);
  const hasCondition = blocks.some((b) => b.type === "repeat_3_condition");
  const hasThreshold = blocks.some((b) => b.type === "digit_threshold");
  const actions = blocks.filter((b) => b.type === "buy_under_action" || b.type === "buy_over_action").length;
  const workspaceComplete = hasCondition && hasThreshold && actions >= 2;

  blocks.forEach((block) => {
    if (!block.svgGroup_) return;
    let valid = workspaceComplete;
    if (block.type === "digit_threshold") {
      const threshold = Number(block.getFieldValue("THRESHOLD"));
      valid = Number.isFinite(threshold) && threshold >= 0 && threshold <= 9;
    }
    block.svgGroup_.classList.toggle("builder-block-valid", valid);
    block.svgGroup_.classList.toggle("builder-block-invalid", !valid);
  });
}

function drawBuilderMiniMap() {
  const canvas = document.getElementById("builderMiniMap");
  if (!canvas || !builderWorkspace) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const w = canvas.width;
  const h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = "rgba(13, 27, 42, 0.78)";
  ctx.fillRect(0, 0, w, h);

  const blocks = builderWorkspace.getAllBlocks(false);
  if (!blocks.length) return;
  const xs = [];
  const ys = [];
  blocks.forEach((b) => {
    const p = b.getRelativeToSurfaceXY();
    const size = b.getHeightWidth();
    xs.push(p.x, p.x + size.width);
    ys.push(p.y, p.y + size.height);
  });
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  const spanX = Math.max(1, maxX - minX);
  const spanY = Math.max(1, maxY - minY);
  const pad = 8;
  const sx = (w - pad * 2) / spanX;
  const sy = (h - pad * 2) / spanY;
  const scale = Math.min(sx, sy);

  blocks.forEach((b) => {
    const p = b.getRelativeToSurfaceXY();
    const size = b.getHeightWidth();
    const bx = pad + (p.x - minX) * scale;
    const by = pad + (p.y - minY) * scale;
    const bw = Math.max(5, size.width * scale);
    const bh = Math.max(4, size.height * scale);
    ctx.fillStyle = "rgba(86, 161, 255, 0.92)";
    ctx.fillRect(bx, by, bw, bh);
  });
}

function getBuilderWorkspace() {
  return builderWorkspace;
}

function loadBuilderXml(xmlText) {
  if (!builderWorkspace || !xmlText || typeof Blockly === "undefined") return;
  const dom = Blockly.utils.xml.textToDom(xmlText);
  builderWorkspace.clear();
  Blockly.Xml.domToWorkspace(dom, builderWorkspace);
  window.requestAnimationFrame(() => Blockly.svgResize(builderWorkspace));
}

function clearBuilderWorkspace() {
  if (!builderWorkspace) return;
  builderWorkspace.clear();
  drawBuilderMiniMap();
}

function fitBuilderWorkspace() {
  if (!builderWorkspace) return;
  builderWorkspace.zoomToFit();
}

function zoomBuilderWorkspace(direction) {
  if (!builderWorkspace) return;
  const delta = Number(direction);
  if (!Number.isFinite(delta) || delta === 0) return;
  try {
    builderWorkspace.zoomCenter(delta > 0 ? 1 : -1);
  } catch (_e) {
    const current = Number(builderWorkspace.scale || 1);
    const next = Math.max(0.35, Math.min(2.6, current + (delta > 0 ? 0.12 : -0.12)));
    builderWorkspace.setScale(next);
    Blockly.svgResize(builderWorkspace);
  }
}

function resetBuilderWorkspaceView() {
  if (!builderWorkspace) return;
  builderWorkspace.setScale(1);
  if (typeof builderWorkspace.scrollCenter === "function") {
    builderWorkspace.scrollCenter();
  }
  Blockly.svgResize(builderWorkspace);
}

function injectQuickTemplateBlocks(payload) {
  if (!builderWorkspace || !payload) return;
  builderWorkspace.clear();
  const stakeVal = Math.max(0.35, Number(payload.stake ?? 1));
  const lossVal = Math.max(0, Number(payload.lossThreshold ?? 25));
  const profitVal = Math.max(0, Number(payload.profitThreshold ?? 20));
  const threshold = Math.min(9, Math.max(0, Number(payload.threshold ?? 5)));
  const preferOver = String(payload.contractType || "").toUpperCase() === "DIGITOVER";
  const logicMode = String(payload.logicMode || "AND").toUpperCase() === "OR" ? "OR" : "AND";
  const trendMode = String(payload.trend || (logicMode === "OR" ? "SIDEWAYS" : "BULLISH")).toUpperCase();
  const rsiOp = String(payload.rsiOp || (preferOver ? "GT" : "LT")).toUpperCase();
  const rsiValue = Math.max(0, Math.min(100, Number(payload.rsiValue ?? (preferOver ? 65 : 35))));

  const stake = builderWorkspace.newBlock("stake_config");
  stake.setFieldValue(String(stakeVal), "STAKE");
  stake.initSvg();
  stake.render();
  stake.moveBy(42, 42);

  const trend = builderWorkspace.newBlock("analysis_trend");
  trend.setFieldValue(trendMode, "TREND");
  trend.initSvg();
  trend.render();
  trend.moveBy(42, 104);

  const rsi = builderWorkspace.newBlock("analysis_rsi");
  rsi.setFieldValue(rsiOp, "OP");
  rsi.setFieldValue(String(rsiValue), "VALUE");
  rsi.initSvg();
  rsi.render();
  rsi.moveBy(42, 166);

  const logic = builderWorkspace.newBlock("logic_gate");
  logic.setFieldValue(logicMode, "MODE");
  logic.initSvg();
  logic.render();
  logic.moveBy(42, 228);

  const condition = builderWorkspace.newBlock("repeat_3_condition");
  condition.initSvg();
  condition.render();
  condition.moveBy(42, 290);

  const digitThreshold = builderWorkspace.newBlock("digit_threshold");
  digitThreshold.setFieldValue(String(threshold), "THRESHOLD");
  digitThreshold.initSvg();
  digitThreshold.render();
  digitThreshold.moveBy(42, 352);

  const buyTrue = builderWorkspace.newBlock(preferOver ? "buy_over_action" : "buy_under_action");
  buyTrue.initSvg();
  buyTrue.render();
  buyTrue.moveBy(42, 414);

  const buyFalse = builderWorkspace.newBlock(preferOver ? "buy_under_action" : "buy_over_action");
  buyFalse.initSvg();
  buyFalse.render();
  buyFalse.moveBy(42, 476);

  const profit = builderWorkspace.newBlock("profit_limit");
  profit.setFieldValue(String(profitVal), "PROFIT");
  profit.initSvg();
  profit.render();
  profit.moveBy(42, 538);

  const loss = builderWorkspace.newBlock("loss_limit");
  loss.setFieldValue(String(lossVal), "LOSS");
  loss.initSvg();
  loss.render();
  loss.moveBy(42, 600);

  const restart = builderWorkspace.newBlock("restart_condition");
  restart.initSvg();
  restart.render();
  restart.moveBy(42, 662);

  const chain = [stake, trend, rsi, logic, condition, digitThreshold, buyTrue, buyFalse, profit, loss, restart];
  for (let i = 0; i < chain.length - 1; i += 1) {
    const a = chain[i];
    const b = chain[i + 1];
    if (a.nextConnection && b.previousConnection && !a.nextConnection.isConnected()) {
      try {
        a.nextConnection.connect(b.previousConnection);
      } catch (_e) {
        // fallback to loose layout if block shapes mismatch
      }
    }
  }

  window.requestAnimationFrame(() => {
    Blockly.svgResize(builderWorkspace);
    fitBuilderWorkspace();
    drawBuilderMiniMap();
    validateBuilderBlocks();
  });
}

function getBuilderTemplateLibrary() {
  return BUILDER_TEMPLATE_LIBRARY.slice();
}

function filterBuilderToolbox(query = "") {
  if (!builderWorkspace || !builderToolboxConfig) return;
  const q = String(query || "").trim().toLowerCase();
  if (!q) {
    builderWorkspace.updateToolbox(builderToolboxConfig);
    return;
  }
  const aliases = {
    analysis_logics: ["analysis", "logic", "trend", "rsi"],
    trade_parameters: ["stake", "threshold", "profit"],
    purchase_conditions: ["repeat", "digit"],
    sell_conditions: ["loss", "profit"],
    restart_conditions: ["restart"],
    analysis: ["buy", "over", "under"],
  };
  const terms = aliases[q] || [q];
  const filtered = {
    ...builderToolboxConfig,
    contents: builderToolboxConfig.contents
      .map((cat) => ({
        ...cat,
        contents: (cat.contents || []).filter((item) => {
          const type = String(item.type || "").toLowerCase();
          const name = String(cat.name || "").toLowerCase();
          return terms.some((term) => type.includes(term) || name.includes(term));
        }),
      }))
      .filter((cat) => (cat.contents || []).length > 0),
  };
  builderWorkspace.updateToolbox(filtered);
}

function resetBuilderWorkspaceToDefault() {
  loadStrategyIntoWorkspace(DEFAULT_STRATEGY);
  if (typeof window !== "undefined" && builderWorkspace) {
    window.requestAnimationFrame(() => Blockly.svgResize(builderWorkspace));
  }
}

function extractStrategyFromWorkspace() {
  if (!builderWorkspace) return null;

  let threshold = 5;
  let trade = "UNDER";
  let elseTrade = "OVER";
  let stake = null;
  let takeProfit = null;
  let stopLoss = null;

  builderWorkspace.getAllBlocks(false).forEach((block) => {
    if (block.type === "digit_threshold") {
      threshold = Number(block.getFieldValue("THRESHOLD"));
    } else if (block.type === "stake_config") {
      const raw = Number(block.getFieldValue("STAKE"));
      if (Number.isFinite(raw) && raw > 0) stake = raw;
    } else if (block.type === "profit_limit") {
      const raw = Number(block.getFieldValue("PROFIT"));
      if (Number.isFinite(raw) && raw >= 0) takeProfit = raw;
    } else if (block.type === "loss_limit") {
      const raw = Number(block.getFieldValue("LOSS"));
      if (Number.isFinite(raw) && raw >= 0) stopLoss = raw;
    } else if (block.type === "buy_under_action") {
      trade = "UNDER";
    } else if (block.type === "buy_over_action") {
      elseTrade = "OVER";
    }
  });

  const strategy = {
    type: "digit_strategy",
    condition: "repeat_3",
    action: "over_under",
    active_action: "over_under",
    actions: {
      over_under: {
        enabled: true,
        rules: {
          if_digit_greater_equal: Math.min(Math.max(threshold, 0), 9),
          trade,
          else_trade: elseTrade,
        },
      },
      rise_fall: {
        enabled: false,
        rules: {
          if_digit_greater_equal: 5,
          trade: "RISE",
          else_trade: "FALL",
        },
      },
    },
  };
  if (stake != null || takeProfit != null || stopLoss != null) {
    strategy.quick_params = {
      ...(stake != null ? { stake } : {}),
      ...(takeProfit != null ? { take_profit: takeProfit } : {}),
      ...(stopLoss != null ? { stop_loss: stopLoss } : {}),
    };
  }
  return strategy;
}

function loadStrategyIntoWorkspace(strategy) {
  if (!builderWorkspace) return;
  builderWorkspace.clear();

  const condition = builderWorkspace.newBlock("repeat_3_condition");
  condition.initSvg();
  condition.render();
  condition.moveBy(40, 40);

  const threshold = builderWorkspace.newBlock("digit_threshold");
  const activeAction = strategy.active_action ?? strategy.action ?? "over_under";
  const ouRules =
    strategy.actions?.over_under?.rules ??
    (activeAction === "over_under" ? strategy.rules : null) ??
    {};
  threshold.setFieldValue(String(ouRules.if_digit_greater_equal ?? 5), "THRESHOLD");
  threshold.initSvg();
  threshold.render();
  threshold.moveBy(40, 110);

  const buyTrue =
    (ouRules.trade ?? "UNDER") === "UNDER"
      ? builderWorkspace.newBlock("buy_under_action")
      : builderWorkspace.newBlock("buy_over_action");
  buyTrue.initSvg();
  buyTrue.render();
  buyTrue.moveBy(40, 180);

  const buyFalse =
    (ouRules.else_trade ?? "OVER") === "OVER"
      ? builderWorkspace.newBlock("buy_over_action")
      : builderWorkspace.newBlock("buy_under_action");
  buyFalse.initSvg();
  buyFalse.render();
  buyFalse.moveBy(40, 250);

  window.requestAnimationFrame(() => Blockly.svgResize(builderWorkspace));
}
