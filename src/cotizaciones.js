/* Actualizacion automatica de CCL y precios.
   Se comprobo que las tres fuentes permiten CORS desde el dominio de la app,
   asi que el telefono puede pedirlas directo, sin intermediarios. */

// Bonos y ONs cotizan por cada 100 de valor nominal.
export const POR_100 = new Set([
  "AE38","AL29","AL30","AL35","AL41","AO27","AO28","AO29","AN29","BDC28",
  "BPOA7","BPOB7","BPOC7","BPOD7","BPOA8","BPOB8","BC37D","GD29","GD30","GD35",
  "GD38","GD41","GD46","TVPP","DICP","PARP","CUAP",
]);
// Obligaciones negociables conocidas: tambien cotizan por 100 nominales.
// Lista explicita en vez de "termina en O", porque hay acciones que terminan en O.
const ONS = new Set("IRCFO IRCJO IRCNO IRCOO IRCPO IRCQO CAC5O CACBO CACDO YMCIO YMCJO YMCQO YMCTO YMCXO YMCYO YMCZO MGCHO MGCJO MGCMO MGCNO MGCOO MGCQO MGCRO MGCTO MTCGO MTC2O TLC1O TLC5O TLCDO TLCMO TLCOO TLCPO TLCQO TLCTO TLCUO TLCVO TLCWO YCA6O CP32O CP36O CP37O CP38O CP40O RCCMO RCCRO NDT25 PNDCO PECNO".split(" "));
const esPor100 = tk => POR_100.has(tk) || ONS.has(tk);

const dd = n => String(n).padStart(2, "0");
const fmtAmbito = d => `${dd(d.getDate())}-${dd(d.getMonth() + 1)}-${d.getFullYear()}`;

/** Ultimos ~25 dias de CCL desde mercados.ambito.com. */
export async function traerCCL() {
  const hoy = new Date();
  const desde = new Date(hoy.getTime() - 25 * 86400000);
  const url = `https://mercados.ambito.com/dolarrava/cl/historico-general/${fmtAmbito(desde)}/${fmtAmbito(hoy)}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error("ambito respondio " + r.status);
  const j = await r.json();
  const out = {};
  for (const fila of j.slice(1)) {
    const [f, v] = fila;
    if (!f || !v) continue;
    const [d, m, y] = String(f).split("/");
    out[`${y}-${m}-${d}`] = parseFloat(String(v).replace(/\./g, "").replace(",", "."));
  }
  if (!Object.keys(out).length) throw new Error("ambito no devolvio datos");
  return out;
}

/** Precios en pesos de BYMA (data912) para los tickers que se le pidan. */
export async function traerPreciosARS(tickers) {
  const quiero = new Set(tickers.filter(t => !t.endsWith(".US")));
  const eps = ["arg_cedears", "arg_stocks", "arg_bonds", "arg_corp", "arg_notes"];
  const out = {};
  for (const ep of eps) {
    let j;
    try {
      const r = await fetch(`https://data912.com/live/${ep}`);
      if (!r.ok) continue;
      j = await r.json();
    } catch { continue; }
    for (const row of j) {
      const s = row.symbol;
      if (!quiero.has(s) || out[s] || !row.c) continue;
      out[s] = { p: esPor100(s) ? row.c / 100 : row.c, m: "ARS" };
    }
  }
  return out;
}

/** Precios en dolares del mercado norteamericano (stockanalysis). */
export async function traerPreciosUSD(tickers) {
  const quiero = tickers.filter(t => t.endsWith(".US"));
  const out = {};
  for (const t of quiero) {
    try {
      const r = await fetch(`https://stockanalysis.com/api/quotes/s/${t.slice(0, -3)}`);
      const j = await r.json();
      if (j && j.data && j.data.p) out[t] = { p: j.data.p, m: "USD" };
    } catch { /* si falla uno, sigue con el resto */ }
  }
  return out;
}

/** Todo junto. Devuelve lo que consiguio y los errores, sin tirar excepcion. */
export async function actualizarTodo(tickers) {
  const res = { ccl: {}, precios: {}, errores: [] };
  const [c, a, u] = await Promise.allSettled([
    traerCCL(), traerPreciosARS(tickers), traerPreciosUSD(tickers),
  ]);
  if (c.status === "fulfilled") res.ccl = c.value;
  else res.errores.push("CCL: " + c.reason.message);
  if (a.status === "fulfilled") Object.assign(res.precios, a.value);
  else res.errores.push("precios BYMA: " + a.reason.message);
  if (u.status === "fulfilled") Object.assign(res.precios, u.value);
  else res.errores.push("precios USA: " + u.reason.message);
  return res;
}
