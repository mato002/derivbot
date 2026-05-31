const AnalysisChart = (() => {
  function create({ priceEl, rsiEl }) {
    const base = {
      layout: { background: { type: "solid", color: "#ffffff" }, textColor: "#1a2634" },
      grid: { vertLines: { color: "#e6e9ef" }, horzLines: { color: "#e6e9ef" } },
      rightPriceScale: { borderColor: "#e6e9ef" },
      timeScale: {
        borderColor: "#e6e9ef",
        timeVisible: true,
        secondsVisible: true,
      },
      crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
      handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
      handleScroll: { mouseWheel: true, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: true },
    };

    const main = LightweightCharts.createChart(priceEl, base);
    const candles = main.addCandlestickSeries({
      upColor: "#22ab94",
      downColor: "#ef5350",
      borderVisible: false,
      wickUpColor: "#22ab94",
      wickDownColor: "#ef5350",
    });
    const ma = main.addLineSeries({ color: "#d0a730", lineWidth: 2 });

    const rsiChart = LightweightCharts.createChart(rsiEl, {
      ...base,
      rightPriceScale: { borderColor: "#e6e9ef", scaleMargins: { top: 0.1, bottom: 0.1 } },
    });
    const rsi = rsiChart.addLineSeries({ color: "#4caaa4", lineWidth: 2 });
    const rsi70 = rsiChart.addLineSeries({ color: "#d56b6b", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted });
    const rsi30 = rsiChart.addLineSeries({ color: "#4d77d9", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dotted });

    const sync = (a, b) => {
      a.timeScale().subscribeVisibleLogicalRangeChange((range) => {
        if (range) b.timeScale().setVisibleLogicalRange(range);
      });
    };
    sync(main, rsiChart);
    sync(rsiChart, main);

    function setData({ candlesData, maData, rsiData, markers }) {
      candles.setData(candlesData || []);
      ma.setData(maData || []);
      rsi.setData(rsiData || []);
      const bounds = (candlesData || []).map((c) => ({ time: Number(c.time), value: 70 }));
      const bounds2 = (candlesData || []).map((c) => ({ time: Number(c.time), value: 30 }));
      rsi70.setData(bounds);
      rsi30.setData(bounds2);
      candles.setMarkers(markers || []);
    }

    function updateLast({ candle, maPoint, rsiPoint }) {
      if (candle) candles.update(candle);
      if (maPoint) ma.update(maPoint);
      if (rsiPoint) rsi.update(rsiPoint);
    }

    function resize() {
      const width = priceEl.clientWidth || 760;
      const isV2 = document.body.classList.contains("analysis-v2-page");
      const mainHeight = isV2
        ? Math.max(320, Math.min(620, Math.floor(window.innerHeight * 0.48)))
        : Math.max(360, Math.floor(width * 0.45));
      const rsiHeight = isV2 ? Math.max(120, Math.floor(mainHeight * 0.28)) : 170;
      main.applyOptions({ width, height: mainHeight });
      rsiChart.applyOptions({ width, height: rsiHeight });
    }

    function fit() {
      main.timeScale().fitContent();
      rsiChart.timeScale().fitContent();
    }

    return { main, candles, ma, rsi, setData, updateLast, resize, fit };
  }

  return { create };
})();

window.AnalysisChart = AnalysisChart;
