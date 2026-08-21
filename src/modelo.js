/* Motor de analisis: mismas reglas que el pipeline de escritorio.
   - De cada fila se usa SIEMPRE la primera fecha en orden cronologico.
   - El CCL se toma de esa misma fecha.
   - Costo promedio para imputar la ganancia al dia de cada venta. */

const BROKER_NOM = {
  cocos: "Cocos Capital", bullmarket: "Bull Market", iol: "InvertirOnline",
};

/* --------------------------------------------------------------- ledger */

/** Une operaciones nuevas al historial sin duplicar (clave: broker + id). */
export function fusionar(historial, nuevas) {
  const vistos = new Set(historial.map(o => o.broker + "|" + o.id));
  const agregadas = [];
  for (const o of nuevas) {
    const k = o.broker + "|" + o.id;
    if (vistos.has(k)) continue;
    vistos.add(k);
    agregadas.push(o);
  }
  const todo = historial.concat(agregadas);
  todo.sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : 0));
  return { historial: todo, agregadas: agregadas.length, repetidas: nuevas.length - agregadas.length };
}

/* ------------------------------------------------------------------ CCL */

export function buscarCCL(ccl, fechas, fecha) {
  if (ccl[fecha]) return { valor: ccl[fecha], exacta: true };
  // la mas cercana en el tiempo
  let mejor = null, dist = Infinity;
  const t = Date.parse(fecha);
  for (const f of fechas) {
    const d = Math.abs(Date.parse(f) - t);
    if (d < dist) { dist = d; mejor = f; }
  }
  return mejor ? { valor: ccl[mejor], exacta: false, usada: mejor } : { valor: null, exacta: false };
}

/* ------------------------------------------------------------- analisis */

export function analizar(historial, ccl, precios, hoy) {
  const fechasCCL = Object.keys(ccl).sort();
  const cclHoy = buscarCCL(ccl, fechasCCL, hoy).valor;

  // En IOL, comprar AL30 en pesos y vender AL30C/AL30D en dolares es una compra
  // de dolares (mismo papel, distinta liquidacion), no una operacion de inversion.
  const tksIOL = new Set(historial.filter(o => o.broker === "iol").map(o => o.ticker));
  const normalizar = o => {
    const t = o.ticker || "";
    if (o.broker === "iol" && !t.endsWith(".US") && t.length > 1 &&
        (t.endsWith("C") || t.endsWith("D")) && tksIOL.has(t.slice(0, -1))) {
      return t.slice(0, -1);
    }
    return t;
  };

  const ops = historial.map(o => {
    const tk = normalizar(o);
    const { valor: tasa } = buscarCCL(ccl, fechasCCL, o.fecha);
    // IOL informa la comision en PESOS para BYMA aunque el papel liquide en
    // dolares: la moneda de la comision sigue al mercado, no a la operacion.
    const c = Math.abs(o.costos_extra || 0);
    let extra = 0;
    if (c) extra = (o.broker === "iol" && !String(o.cuenta).endsWith("/BCBA")) ? c : c / tasa;
    const usd = o.moneda === "ARS" ? (o.total / tasa - extra) : (o.total - extra);
    return { ...o, ticker: tk, usd, ccl: o.moneda === "ARS" ? tasa : null };
  });

  const trades = ops.filter(o => (o.clase === "compra" || o.clase === "venta") && o.ticker)
    .sort((a, b) => (a.fecha < b.fecha ? -1 : a.fecha > b.fecha ? 1 : (a.id < b.id ? -1 : 1)));

  const acum = (arr, clase) => {
    const m = new Map();
    arr.filter(o => o.clase === clase && o.ticker).forEach(o => {
      const k = o.broker + "|" + o.ticker;
      m.set(k, (m.get(k) || 0) + o.usd);
    });
    return m;
  };
  const rentas = acum(ops, "renta"), retenc = acum(ops, "retencion");

  // recorrido cronologico por especie
  const porEspecie = new Map();
  trades.forEach(o => {
    const k = o.broker + "|" + o.ticker;
    if (!porEspecie.has(k)) porEspecie.set(k, []);
    porEspecie.get(k).push(o);
  });

  const posiciones = [], eventos = [];
  for (const [k, g] of porEspecie) {
    const [broker, ticker] = k.split("|");
    let unidades = 0, costo = 0, compras = 0, ventas = 0;
    let descubierto = false, sinCosto = 0;
    const evs = [];
    for (const r of g) {
      if (r.clase === "compra") {
        unidades += r.cantidad; costo += -r.usd; compras += -r.usd;
      } else {
        let q = -r.cantidad, cobrado = r.usd;
        ventas += cobrado;
        if (unidades <= 1e-9) { descubierto = true; sinCosto += cobrado; continue; }
        if (q > unidades + 1e-9) {
          const prop = unidades / q;
          sinCosto += cobrado * (1 - prop);
          cobrado *= prop; q = unidades; descubierto = true;
        }
        const cv = (costo / unidades) * q;
        evs.push({
          fecha: r.fecha, broker, ticker, unidades: q,
          cobrado, costo: cv, ganancia: cobrado - cv, ccl: r.ccl,
        });
        unidades -= q; costo -= cv;
      }
    }
    const categoria = descubierto ? "arrastre" : (unidades > 1e-9 ? "abierta" : "limpia");
    const pr = precios[ticker];
    let valor = null;
    if (unidades > 1e-9 && pr) {
      valor = pr.p * unidades;
      if (pr.m !== "USD") valor /= cclHoy;
    }
    posiciones.push({
      broker, broker_nom: BROKER_NOM[broker] || broker, ticker, categoria,
      unidades, costo_remanente: costo, compras, ventas,
      renta: (rentas.get(k) || 0) - Math.abs(retenc.get(k) || 0),
      realizado: evs.reduce((s, e) => s + e.ganancia, 0),
      cobrado_sin_costo: sinCosto,
      valor_actual: valor,
      no_realizado: valor === null ? null : valor - costo,
      precio_hoy: pr ? pr.p : null, moneda_precio: pr ? pr.m : null,
      desde: g[0].fecha, n_ops: g.length,
    });
    evs.forEach(e => eventos.push({ ...e, categoria }));
  }

  /* ------------------------------------------------------------ metricas */
  const lim = eventos.filter(e => e.categoria === "limpia");
  const realizado = lim.reduce((s, e) => s + e.ganancia, 0);

  const clavesLim = new Set(posiciones.filter(p => p.categoria === "limpia")
    .map(p => p.broker + "|" + p.ticker));
  const delta = new Map();
  const estado = new Map();
  let comprasBrutas = 0;
  for (const r of trades) {
    const k = r.broker + "|" + r.ticker;
    if (!clavesLim.has(k)) continue;
    if (!estado.has(k)) estado.set(k, [0, 0]);
    const st = estado.get(k);
    if (r.clase === "compra") {
      const c = -r.usd;
      st[0] += r.cantidad; st[1] += c; comprasBrutas += c;
      delta.set(r.fecha, (delta.get(r.fecha) || 0) + c);
    } else {
      if (st[0] <= 0) continue;
      const q = Math.min(-r.cantidad, st[0]);
      const lib = (st[1] / st[0]) * q;
      st[0] -= q; st[1] -= lib;
      delta.set(r.fecha, (delta.get(r.fecha) || 0) - lib);
    }
  }

  const fIni = [...delta.keys()].sort()[0] || hoy;
  const serie = [];
  let a = 0;
  for (let d = new Date(fIni + "T00:00:00Z"); d <= new Date(hoy + "T00:00:00Z");
       d.setUTCDate(d.getUTCDate() + 1)) {
    const f = d.toISOString().slice(0, 10);
    a += delta.get(f) || 0;
    serie.push({ fecha: f, capital: Math.max(a, 0) });
  }
  const pico = Math.max(0, ...serie.map(s => s.capital));
  const fPico = (serie.find(s => s.capital === pico) || {}).fecha || hoy;
  const promedio = serie.length ? serie.reduce((s, x) => s + x.capital, 0) / serie.length : 0;
  const anios = serie.length / 365.25;

  const abiertas = posiciones.filter(p => p.categoria !== "limpia" && p.valor_actual !== null);
  const valorAbierto = abiertas.reduce((s, p) => s + p.valor_actual, 0);
  const costoAbierto = abiertas.reduce((s, p) => s + p.costo_remanente, 0);

  const agrupar = (arr, key, val) => {
    const m = {};
    arr.forEach(x => { const k = key(x); m[k] = (m[k] || 0) + val(x); });
    return m;
  };
  const diarioObj = agrupar(lim, e => e.fecha, e => e.ganancia);
  const diarioN = agrupar(lim, e => e.fecha, () => 1);
  const diario = Object.keys(diarioObj).sort()
    .map(f => ({ fecha: f, ganancia: diarioObj[f], ops: diarioN[f] }));
  const mensualObj = agrupar(lim, e => e.fecha.slice(0, 7), e => e.ganancia);
  const mensualN = agrupar(lim, e => e.fecha.slice(0, 7), () => 1);
  const mensual = Object.keys(mensualObj).sort()
    .map(m => ({ mes: m, ganancia: mensualObj[m], ops: mensualN[m] }));

  /* ---------------------------------------------------------- dividendos */
  const DIV = new Set(["DIVIDENDOS", "Dividendos", "PAGO DIV", "DIV DOLARES",
    "Dividendos U$S", "Dividendos USD", "DIVIDENDOS EN ESPECIE"]);
  const AMO = new Set(["RENTA Y AMORTIZ", "Renta Y Amortizacion",
    "Renta y Amortizacion USD", "RENTA Y AMORTIZACION EN ESPECIE"]);

  const inc = ops.filter(o => ["renta", "retencion", "renta_sin_ticker"].includes(o.clase))
    .map(o => ({
      ...o,
      // Cocos rotula mal los dividendos y deja el importe real en `cantidad`
      monto: (o.broker === "cocos" && String(o.tipo_op).includes("EN ESPECIE"))
        ? o.cantidad : o.usd,
      grupo: DIV.has(o.tipo_op) ? "dividendos" : (AMO.has(o.tipo_op) ? "renta_amort" : "retencion"),
    }));
  const suma = g => inc.filter(x => x.grupo === g).reduce((s, x) => s + x.monto, 0);
  const dividendos = suma("dividendos"), rentaAmort = suma("renta_amort"), retenciones = suma("retencion");
  const divBroker = agrupar(inc.filter(x => x.grupo === "dividendos"),
    x => BROKER_NOM[x.broker] || x.broker, x => x.monto);
  const divAnio = agrupar(inc.filter(x => x.grupo === "dividendos"),
    x => x.fecha.slice(0, 4), x => x.monto);
  const divTk = agrupar(inc.filter(x => x.grupo === "dividendos" && x.ticker),
    x => x.ticker, x => x.monto);
  const divTop = Object.entries(divTk).sort((a, b) => b[1] - a[1]).slice(0, 8)
    .map(([ticker, monto]) => ({ ticker, monto }));

  const tna = (r, c) => (c > 0 && anios > 0) ? (Math.pow(1 + r / c, 1 / anios) - 1) * 100 : 0;

  return {
    generado: hoy, ccl_hoy: cclHoy,
    ledger: {
      operaciones: historial.length,
      desde: historial.length ? historial[0].fecha : null,
      hasta: historial.length ? historial[historial.length - 1].fecha : null,
      por_broker: agrupar(historial, o => BROKER_NOM[o.broker] || o.broker, () => 1),
    },
    metricas: {
      realizado, no_realizado: valorAbierto - costoAbierto,
      valor_abierto: valorAbierto, costo_abierto: costoAbierto,
      pico, fecha_pico: fPico, promedio, compras_brutas: comprasBrutas,
      rotacion: pico ? comprasBrutas / pico : 0,
      anios, dias: serie.length,
      pct_pico: pico ? realizado / pico * 100 : 0,
      pct_promedio: promedio ? realizado / promedio * 100 : 0,
      tna_pico: tna(realizado, pico), tna_promedio: tna(realizado, promedio),
      dias_operados: diario.length,
      dias_positivos: diario.filter(d => d.ganancia > 0).length,
      meses_positivos: mensual.filter(m => m.ganancia > 0).length,
      meses_totales: mensual.length,
      n_limpias: posiciones.filter(p => p.categoria === "limpia").length,
      n_abiertas: posiciones.filter(p => p.categoria === "abierta").length,
      n_arrastre: posiciones.filter(p => p.categoria === "arrastre").length,
      cobrado_sin_costo: posiciones.reduce((s, p) => s + p.cobrado_sin_costo, 0),
      dividendos, renta_amort: rentaAmort, retenciones,
      n_dividendos: inc.filter(x => x.grupo === "dividendos").length,
      n_renta_amort: inc.filter(x => x.grupo === "renta_amort").length,
    },
    dividendos: {
      total: dividendos, por_broker: divBroker, por_anio: divAnio, top: divTop,
      renta_amort_total: rentaAmort, retenciones,
    },
    posiciones, eventos, diario, mensual, capital_serie: serie,
  };
}
