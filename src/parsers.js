/* Parsers de extractos, 100% en el navegador. Sin dependencias externas:
   el .xlsx se descomprime con DecompressionStream, nativo del navegador. */

/* ---------------------------------------------------------------- utilidades */

/** Numero en formato argentino: "1.234,56" -> 1234.56 */
export function numAR(s) {
  if (s === null || s === undefined) return 0;
  const t = String(s).trim().replace(/[^\d,.\-]/g, "");
  if (!t) return 0;
  return parseFloat(t.replace(/\./g, "").replace(",", ".")) || 0;
}

/** Numero tal como lo guarda el XML de un .xlsx: siempre "1234.56", punto decimal.
    OJO: no pasarlo por numAR, que borraria el punto por creerlo separador de miles. */
export function numPlano(s) {
  if (s === null || s === undefined || s === "") return 0;
  const t = String(s).trim();
  return (t.includes(",") ? numAR(t) : parseFloat(t)) || 0;
}

/** "21-08-2026" | "21/8/2026" -> "2026-08-21" */
export function fechaISO(s) {
  if (!s) return null;
  const t = String(s).trim().split(" ")[0];
  const m = t.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, "0")}-${m[1].padStart(2, "0")}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  return null;
}

/** De las fechas de una fila, la primera en orden cronologico. */
export function primeraFecha(...fs) {
  const v = fs.filter(Boolean).sort();
  return v.length ? v[0] : null;
}

/** Serial de fecha de Excel -> ISO. Excel cuenta desde 1899-12-30. */
function serialAFecha(n) {
  const ms = Math.round((n - 25569) * 86400000);
  return new Date(ms).toISOString().slice(0, 10);
}

/* ------------------------------------------------------------------- ZIP/XLSX */

/** Descomprime un buffer deflate-raw usando la API nativa. */
async function inflateRaw(bytes) {
  const ds = new DecompressionStream("deflate-raw");
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Lee un .xlsx (ZIP) y devuelve { nombreArchivo: textoXML } */
async function abrirZip(buf) {
  const dv = new DataView(buf);
  const u8 = new Uint8Array(buf);
  // localizar el End Of Central Directory
  let eocd = -1;
  for (let i = u8.length - 22; i >= 0 && i > u8.length - 65558; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error("No parece un .xlsx valido (falta el indice del ZIP)");

  const nEntradas = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const salida = {};
  const dec = new TextDecoder("utf-8");

  for (let i = 0; i < nEntradas; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const metodo = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nLen = dv.getUint16(p + 28, true);
    const eLen = dv.getUint16(p + 30, true);
    const cLen = dv.getUint16(p + 32, true);
    const offset = dv.getUint32(p + 42, true);
    const nombre = dec.decode(u8.subarray(p + 46, p + 46 + nLen));
    p += 46 + nLen + eLen + cLen;

    // cabecera local: los tamanios de nombre/extra pueden diferir
    const lnLen = dv.getUint16(offset + 26, true);
    const leLen = dv.getUint16(offset + 28, true);
    const ini = offset + 30 + lnLen + leLen;
    const crudo = u8.subarray(ini, ini + compSize);

    if (!/\.(xml|rels)$/i.test(nombre)) continue;
    salida[nombre] = metodo === 0 ? dec.decode(crudo) : dec.decode(await inflateRaw(crudo));
  }
  return salida;
}

/** Convierte la primera hoja de un .xlsx en matriz de celdas (texto). */
export async function leerXLSX(buf) {
  const z = await abrirZip(buf);
  const dp = new DOMParser();

  // cadenas compartidas
  let compartidas = [];
  if (z["xl/sharedStrings.xml"]) {
    const d = dp.parseFromString(z["xl/sharedStrings.xml"], "application/xml");
    compartidas = [...d.getElementsByTagName("si")].map(si =>
      [...si.getElementsByTagName("t")].map(t => t.textContent).join(""));
  }

  const nombreHoja = Object.keys(z).find(k => /^xl\/worksheets\/sheet1\.xml$/i.test(k))
    || Object.keys(z).find(k => /^xl\/worksheets\/.*\.xml$/i.test(k));
  if (!nombreHoja) throw new Error("El .xlsx no tiene hojas legibles");
  const hoja = dp.parseFromString(z[nombreHoja], "application/xml");

  // que formatos son fecha (para no devolver el numero serial crudo)
  const fmtFecha = new Set();
  if (z["xl/styles.xml"]) {
    const st = dp.parseFromString(z["xl/styles.xml"], "application/xml");
    const custom = {};
    [...st.getElementsByTagName("numFmt")].forEach(n => {
      custom[n.getAttribute("numFmtId")] = n.getAttribute("formatCode") || "";
    });
    const xf = st.getElementsByTagName("cellXfs")[0];
    if (xf) {
      [...xf.getElementsByTagName("xf")].forEach((x, i) => {
        const id = x.getAttribute("numFmtId");
        const code = custom[id] || "";
        const idn = parseInt(id, 10);
        if ((idn >= 14 && idn <= 22) || (idn >= 45 && idn <= 47) || /[dmyhs]/i.test(code) && /[/\-]/.test(code)) {
          fmtFecha.add(String(i));
        }
      });
    }
  }

  const filas = [];
  for (const row of hoja.getElementsByTagName("row")) {
    const celdas = [];
    for (const c of row.getElementsByTagName("c")) {
      const ref = c.getAttribute("r") || "";
      const col = ref.replace(/\d/g, "");
      let idx = 0;
      for (const ch of col) idx = idx * 26 + (ch.charCodeAt(0) - 64);
      idx = Math.max(0, idx - 1);

      const t = c.getAttribute("t");
      const vEl = c.getElementsByTagName("v")[0];
      let val = "";
      if (t === "s") {
        val = compartidas[parseInt(vEl?.textContent || "0", 10)] ?? "";
      } else if (t === "inlineStr") {
        val = [...c.getElementsByTagName("t")].map(x => x.textContent).join("");
      } else if (vEl) {
        val = vEl.textContent;
        const s = c.getAttribute("s");
        if (s !== null && fmtFecha.has(s) && val !== "" && !isNaN(+val)) {
          val = serialAFecha(+val);
        }
      }
      celdas[idx] = val;
    }
    filas.push(celdas);
  }
  return filas;
}

/* ------------------------------------------------------------------ CSV Cocos */

function partirCSV(texto, sep) {
  return texto.split(/\r?\n/).filter(l => l.trim()).map(l => l.split(sep));
}

/* ---------------------------------------------------- clasificacion por broker */

const BM = {
  compra: new Set(["COMPRA NORMAL", "COMPRA PARIDAD"]),
  venta: new Set(["VENTA", "VENTA PARIDAD"]),
  renta: new Set(["DIVIDENDOS", "RENTA Y AMORTIZ", "DIV DOLARES", "PAGO DIV"]),
  retencion: new Set(["RETENCION", "RETENCION DOLARES"]),
  caja: new Set(["ORDEN DE PAGO", "ORD PAGO DOLARES", "RECIBO DE COBRO",
    "REC COBRO DOLARES", "NOTA DE CREDITO U$S", "NOTA DE DEBITOS U$S"]),
};

const CC = {
  compra: new Set(["Compra", "Compra Dolar Mep", "Compra Cable"]),
  venta: new Set(["Venta", "Venta Dolar Mep"]),
  renta: new Set(["Dividendos", "Dividendos U$S", "Dividendos USD",
    "Renta Y Amortizacion", "Renta y Amortizacion USD"]),
  sinTicker: new Set(["DIVIDENDOS EN ESPECIE", "RENTA Y AMORTIZACION EN ESPECIE"]),
  caja: new Set(["Recibo De Cobro", "Recibo De Cobro Dolares", "Orden De Pago",
    "Orden De Pago Usd", "Nota De Credito Conversion", "Nota De Credito Conversion Cable",
    "Nota De Debito", "Liquidacion Rescate Fci", "Liquidacion Suscripcion Fci",
    "Liq Rescate Fci Usd", "Liq Suscripcion Fci Usd", "Concepto EXT migracion",
    "Nc Aranc Exentos Cable"]),
};

const NO_ES_ESPECIE = ["lar estadounidense", "lar MEP"];

function tickerDeReferencia(ref) {
  if (!ref) return "";
  const limpio = String(ref).toUpperCase().replace(/\b(RET|FRACCION|BYMA|PAGO|DIV|CANC)\b/g, " ");
  const c = limpio.split(/\s+/).filter(t => /^[A-Z0-9.]{2,6}$/.test(t));
  return c.length ? c[0] : "";
}

function tickerCocos(instr) {
  if (!instr || !instr.trim()) return "";
  const m = [...String(instr).matchAll(/\(([A-Z0-9.\-]{1,8})\)/g)];
  if (m.length) return m[m.length - 1][1];
  if (NO_ES_ESPECIE.some(x => instr.includes(x))) return "";
  return instr.trim().slice(0, 38);
}

/** Bull Market: un .xlsx por cuenta (PESOS / DOLARES / DOLARES CABLE). */
export async function parseBullMarket(buf, nombreArchivo) {
  const filas = await leerXLSX(buf);
  const n = nombreArchivo.toUpperCase();
  const cuenta = n.includes("CABLE") ? "CABLE" : (n.includes("DOLARES") ? "USD" : "ARS");
  const cab = filas[0].map(x => String(x || "").trim());
  const col = k => cab.findIndex(c => c.toUpperCase() === k);
  const iOp = col("OPERADO"), iLiq = col("LIQUIDA"), iComp = col("COMPROBANTE"),
    iNum = col("NUMERO"), iCant = col("CANTIDAD"), iEsp = col("ESPECIE"),
    iImp = col("IMPORTE"), iRef = col("REFERENCIA");
  if (iOp < 0 || iNum < 0) throw new Error("No parece un extracto de Bull Market");

  const ops = [];
  for (const f of filas.slice(1)) {
    if (!f || f[iNum] === undefined || f[iNum] === "") continue;
    const fa = fechaISO(f[iOp]), fb = fechaISO(f[iLiq]);
    const comp = String(f[iComp] || "").trim();
    let esp = String(f[iEsp] || "").trim();
    let clase;
    if (BM.compra.has(comp)) clase = "compra";
    else if (BM.venta.has(comp)) clase = "venta";
    else if (BM.renta.has(comp)) { clase = "renta"; esp = esp || tickerDeReferencia(f[iRef]); }
    else if (BM.retencion.has(comp)) { clase = "retencion"; esp = esp || tickerDeReferencia(f[iRef]); }
    else if (BM.caja.has(comp)) { clase = "caja"; esp = ""; }
    else clase = "otro";
    ops.push({
      broker: "bullmarket", cuenta, id: `${cuenta}-${f[iNum]}`,
      fecha: primeraFecha(fa, fb), fecha_alt: [fa, fb].filter(Boolean).sort().pop(),
      tipo_op: comp, clase, instrumento: esp, ticker: esp,
      moneda: cuenta === "ARS" ? "ARS" : "USD",
      cantidad: numPlano(f[iCant]), total: numPlano(f[iImp]),
      costos_extra: 0, archivo: nombreArchivo,
    });
  }
  return ops;
}

/** Cocos Capital: CSV con ; y numeros en formato argentino. */
export function parseCocos(texto, nombreArchivo) {
  const filas = partirCSV(texto, ";");
  const cab = filas[0].map(x => x.trim());
  const col = k => cab.indexOf(k);
  const iTk = col("nroTicket"), iFe = col("fechaEjecucion"), iFl = col("fechaLiquidacion"),
    iOp = col("tipoOperacion"), iIn = col("instrumento"), iMo = col("moneda"),
    iCa = col("cantidad"), iTo = col("total");
  if (iTk < 0 || iFe < 0) throw new Error("No parece un CSV de Cocos");

  const ops = [];
  for (const f of filas.slice(1)) {
    if (!f[iTk]) continue;
    const fa = fechaISO(f[iFe]), fb = fechaISO(f[iFl]);
    const op = String(f[iOp] || "").trim();
    let tk = tickerCocos(f[iIn]);
    let clase;
    if (CC.compra.has(op)) clase = "compra";
    else if (CC.venta.has(op)) clase = "venta";
    else if (CC.sinTicker.has(op)) { clase = "renta_sin_ticker"; tk = ""; }
    else if (CC.renta.has(op)) clase = tk ? "renta" : "renta_sin_ticker";
    else if (CC.caja.has(op)) { clase = "caja"; tk = ""; }
    else if (op === "Canje") clase = "canje";
    else clase = "otro";
    ops.push({
      broker: "cocos", cuenta: "", id: String(f[iTk]),
      fecha: primeraFecha(fa, fb), fecha_alt: [fa, fb].filter(Boolean).sort().pop(),
      tipo_op: op, clase, instrumento: f[iIn] || "", ticker: tk,
      moneda: String(f[iMo] || "").trim(),
      cantidad: numAR(f[iCa]), total: numAR(f[iTo]),
      costos_extra: 0, archivo: nombreArchivo,
    });
  }
  return ops;
}

/** InvertirOnline: "OperacionesFinalizadas.xls" es HTML, no Excel. */
export function parseIOL(texto, nombreArchivo) {
  const doc = new DOMParser().parseFromString(texto, "text/html");
  const filas = [...doc.querySelectorAll("tr")]
    .map(tr => [...tr.querySelectorAll("td,th")].map(td => td.textContent.replace(/\s+/g, " ").trim()))
    .filter(r => r.length >= 16);
  if (!filas.length) throw new Error("No parece un export de InvertirOnline");

  const ops = [];
  for (const r of filas.slice(1)) {
    const fa = fechaISO(r[0]), fb = fechaISO(r[1]);
    if (!fa) continue;
    const tipo = r[4].trim();
    const clase = tipo === "Compra" ? "compra" : (tipo === "Venta" ? "venta" : "otro");
    const mercado = r[3].trim();
    const cant = numAR(r[9]);
    const total = numAR(r[12]);
    ops.push({
      broker: "iol", cuenta: `${r[5]}/${mercado}`, id: String(r[2]),
      fecha: primeraFecha(fa, fb), fecha_alt: [fa, fb].filter(Boolean).sort().pop(),
      tipo_op: tipo, clase,
      instrumento: `${r[6]} [${mercado}]`,
      ticker: mercado === "BCBA" ? r[8] : `${r[8]}.US`,
      moneda: r[10].includes("US$") ? "USD" : "ARS",
      cantidad: clase === "compra" ? cant : -cant,
      total: clase === "compra" ? -total : total,
      // IOL informa el total SIN comision: se suma aparte
      costos_extra: numAR(r[13]) + numAR(r[14]),
      archivo: nombreArchivo,
    });
  }
  return ops;
}

/** Detecta el tipo de archivo y lo parsea. */
export async function parseArchivo(file) {
  const nombre = file.name;
  const ext = nombre.toLowerCase().split(".").pop();
  if (ext === "csv") {
    // los CSV de Cocos vienen en latin-1
    const texto = new TextDecoder("windows-1252").decode(await file.arrayBuffer());
    return parseCocos(texto, nombre);
  }
  const buf = await file.arrayBuffer();
  const cabecera = new TextDecoder("latin1").decode(new Uint8Array(buf.slice(0, 400)));
  if (/<html|<link|<table/i.test(cabecera)) {
    return parseIOL(new TextDecoder("windows-1252").decode(buf), nombre);
  }
  if (new Uint8Array(buf)[0] === 0x50 && new Uint8Array(buf)[1] === 0x4b) {
    return parseBullMarket(buf, nombre);
  }
  throw new Error(`No reconozco el formato de "${nombre}"`);
}
