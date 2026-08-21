/* Mi cartera - app privada. Todo corre en el telefono: los archivos no se suben
   a ningun lado y el historial vive en el almacenamiento local del navegador. */
import { parseArchivo } from "./parsers.js?v=3";
import { analizar, fusionar } from "./modelo.js?v=3";
import { actualizarTodo } from "./cotizaciones.js?v=3";

const K_LEDGER = "cartera.ledger.v1";
const K_CCL = "cartera.ccl.v1";
const K_PRECIOS = "cartera.precios.v1";

const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto",
  "septiembre","octubre","noviembre","diciembre"];
const MC = ["ene","feb","mar","abr","may","jun","jul","ago","sep","oct","nov","dic"];

/* ------------------------------------------------------------- formato */
const nf = (v,d=2)=> v==null||isNaN(v) ? "—"
  : (v<0?"−":"") + Math.abs(v).toLocaleString("es-AR",{minimumFractionDigits:d,maximumFractionDigits:d});
const sf = (v,d=2)=> v==null||isNaN(v) ? "—" : (v>0?"+":"") + nf(v,d);
const cls = v => v>0?"gain":(v<0?"loss":"dash");
const usd = (v,d=2)=> v==null||isNaN(v) ? '<span class="dash">—</span>'
  : `<span class="${cls(v)}">${sf(v,d)}</span>`;
const fdmy = f => f ? f.slice(8)+"/"+f.slice(5,7)+"/"+f.slice(0,4) : "—";
const hoyISO = () => new Date().toISOString().slice(0,10);

/* -------------------------------------------------------------- estado */
let LEDGER = [];
let CCL = {};
let PRECIOS = {};
let R = null;                       // resultado del analisis
let estadoCotiz = null;
const $ = id => document.getElementById(id);

const guardar = () => {
  try {
    localStorage.setItem(K_LEDGER, JSON.stringify(LEDGER));
    localStorage.setItem(K_CCL, JSON.stringify(CCL));
    localStorage.setItem(K_PRECIOS, JSON.stringify(PRECIOS));
    return true;
  } catch (e) { return false; }
};

async function arrancar() {
  // base que viene con la app
  const [cclBase, prBase] = await Promise.all([
    fetch("src/ccl.json").then(r=>r.json()).catch(()=>({})),
    fetch("src/precios.json").then(r=>r.json()).catch(()=>({precios:{}})),
  ]);
  CCL = { ...cclBase, ...(JSON.parse(localStorage.getItem(K_CCL) || "{}")) };
  PRECIOS = { ...(prBase.precios||{}), ...(JSON.parse(localStorage.getItem(K_PRECIOS) || "{}")) };
  LEDGER = JSON.parse(localStorage.getItem(K_LEDGER) || "[]");
  recalcular();
  refrescarCotizaciones();          // en segundo plano, no bloquea la pantalla
}

/** Trae CCL y precios sin que el usuario tenga que hacer nada. */
let refrescando = false;
async function refrescarCotizaciones(manual = false) {
  if (refrescando) return;
  refrescando = true;
  estadoCotiz = "buscando";
  pintarEstadoCotiz();
  try {
    const tickers = [...new Set(LEDGER.map(o => o.ticker).filter(Boolean))];
    const r = await actualizarTodo(tickers);
    const nCCL = Object.keys(r.ccl).length, nPr = Object.keys(r.precios).length;
    if (nCCL) CCL = { ...CCL, ...r.ccl };
    if (nPr) PRECIOS = { ...PRECIOS, ...r.precios };
    if (nCCL || nPr) { guardar(); recalcular(); }
    estadoCotiz = r.errores.length
      ? { txt: `Actualizado a medias: ${r.errores.join(" | ")}`, cls: "err" }
      : { txt: `Cotizaciones al dia: ${nCCL} fechas de CCL y ${nPr} precios`, cls: "ok" };
  } catch (e) {
    estadoCotiz = { txt: "No se pudieron actualizar las cotizaciones: " + e.message, cls: "err" };
  }
  refrescando = false;
  pintarEstadoCotiz();
}

function pintarEstadoCotiz() {
  const el = $("estadocot");
  if (!el) return;
  if (estadoCotiz === "buscando") { el.className = "log"; el.textContent = "Buscando cotizaciones..."; return; }
  if (!estadoCotiz) { el.textContent = ""; return; }
  el.className = "log " + (estadoCotiz.cls || "");
  el.textContent = estadoCotiz.txt;
}

function recalcular() {
  const fechas = Object.keys(CCL).sort();
  const hoy = fechas.length ? fechas[fechas.length-1] : hoyISO();
  R = LEDGER.length ? analizar(LEDGER, CCL, PRECIOS, hoy) : null;
  pintarTodo();
}

/* --------------------------------------------------------------- tabs */
const tabs = [...document.querySelectorAll(".tab")];
tabs.forEach(t => t.onclick = () => tabs.forEach(x => {
  const on = x===t;
  x.setAttribute("aria-selected", on);
  $(x.getAttribute("aria-controls")).hidden = !on;
}));

function pintarTodo(){
  $("meta").innerHTML = R
    ? `${R.ledger.operaciones} operaciones<br>${fdmy(R.ledger.desde)} → ${fdmy(R.ledger.hasta)} · CCL <b>${nf(R.ccl_hoy)}</b>`
    : "sin datos — importá tus extractos";
  pintarAbiertas(); pintarCerradas(); pintarMetricas(); pintarDatos();
}

const vacio = msg => `<div class="cav"><p>${msg}</p></div>`;

/* --------------------------------------------------------- 1. abiertas */
let filtroBroker = "todos", orden = {col:"valor_actual", dir:-1};
const COLS = [
  {k:"ticker",t:"Ticker",tipo:"tk"},{k:"broker_nom",t:"Broker",tipo:"bk"},
  {k:"unidades",t:"Unid.",d:0},{k:"costo_remanente",t:"Costo",d:2,pre:"u$s "},
  {k:"valor_actual",t:"Valor hoy",d:2,pre:"u$s "},{k:"no_realizado",t:"No real.",tipo:"sig"},
  {k:"pct",t:"%",tipo:"pct"},{k:"realizado",t:"Realizado",tipo:"sig"},
  {k:"renta",t:"Renta",d:2,pre:"u$s "},{k:"desde",t:"Desde",tipo:"fecha"},
];
const valorCol = (p,k)=> k==="pct"
  ? ((p.no_realizado!=null && p.costo_remanente) ? p.no_realizado/p.costo_remanente*100 : null)
  : p[k];

function pintarAbiertas(){
  const el = $("p-abiertas");
  if(!R){ el.innerHTML = vacio("Todavía no importaste nada. Andá a la pestaña <b>Datos</b> y cargá tus extractos."); return; }
  const todas = R.posiciones.filter(p=>p.unidades>1e-9);
  let filas = todas.filter(p=>filtroBroker==="todos"||p.broker===filtroBroker);
  filas.sort((a,b)=>{
    const x=valorCol(a,orden.col), y=valorCol(b,orden.col);
    if(x==null&&y==null) return 0; if(x==null) return 1; if(y==null) return -1;
    return typeof x==="string" ? x.localeCompare(y)*orden.dir : (x-y)*orden.dir;
  });
  const th = COLS.map(c=>`<th data-col="${c.k}" ${orden.col===c.k?`data-dir="${orden.dir}"`:""}>${c.t}<span class="ar">${orden.dir<0?"▼":"▲"}</span></th>`).join("");
  const tb = filas.map(p=>"<tr>"+COLS.map(c=>{
    const v = valorCol(p,c.k);
    if(c.tipo==="tk") return `<td class="tk"><span class="sym">${p.ticker}</span></td>`;
    if(c.tipo==="bk") return `<td><span class="bk">${p.broker_nom}</span></td>`;
    if(c.tipo==="sig") return `<td class="strong">${usd(v)}</td>`;
    if(c.tipo==="pct") return v==null?'<td><span class="dash">—</span></td>':`<td class="${cls(v)}">${sf(v,1)}%</td>`;
    if(c.tipo==="fecha") return `<td>${fdmy(v)}</td>`;
    if(v==null) return '<td><span class="dash">s/c</span></td>';
    return `<td>${(c.pre||"")+nf(v,c.d)}</td>`;
  }).join("")+"</tr>").join("");
  const val = filas.reduce((s,p)=>s+(p.valor_actual||0),0);
  const cos = filas.reduce((s,p)=>s+(p.valor_actual!=null?p.costo_remanente:0),0);
  const brokers = [...new Set(R.posiciones.map(p=>p.broker))];
  el.innerHTML = `
    <div class="stats">
      <div class="stat"><span class="sl">Posiciones</span><span class="sv">${filas.length}</span>
        <span class="ss">de ${todas.length}</span></div>
      <div class="stat"><span class="sl">Costo</span><span class="sv">u$s ${nf(cos)}</span>
        <span class="ss">en cartera</span></div>
      <div class="stat"><span class="sl">Valor hoy</span><span class="sv">u$s ${nf(val)}</span>
        <span class="ss">${fdmy(R.generado)}</span></div>
      <div class="stat"><span class="sl">No realizado</span><span class="sv ${cls(val-cos)}">${sf(val-cos)}</span>
        <span class="ss ${cls(val-cos)}">${sf(cos?(val-cos)/cos*100:0,1)}%</span></div>
    </div>
    <div class="bar">
      <button class="chip" data-b="todos" aria-pressed="${filtroBroker==="todos"}">Todos</button>
      ${brokers.map(b=>{const n=(R.posiciones.find(p=>p.broker===b)||{}).broker_nom||b;
        return `<button class="chip" data-b="${b}" aria-pressed="${filtroBroker===b}">${n}</button>`;}).join("")}
      <span class="hint">Tocá un encabezado para reordenar</span>
    </div>
    <div class="wrap"><table><thead><tr>${th}</tr></thead><tbody>${tb}</tbody></table></div>`;
  el.querySelectorAll("th").forEach(h=>h.onclick=()=>{
    const c=h.dataset.col; orden = orden.col===c?{col:c,dir:-orden.dir}:{col:c,dir:-1}; pintarAbiertas();
  });
  el.querySelectorAll(".chip").forEach(c=>c.onclick=()=>{ filtroBroker=c.dataset.b; pintarAbiertas(); });
}

/* --------------------------------------------------------- 2. cerradas */
let diaSel = null;

function pintarDetalle(){
  const el = $("detalle"); if(!el) return;
  if(!diaSel){ el.innerHTML = '<p class="vacio-msg">Tocá cualquier día coloreado para ver qué se cerró esa jornada.</p>'; return; }
  const evs = R.eventos.filter(e=>e.categoria==="limpia"&&e.fecha===diaSel).sort((a,b)=>b.ganancia-a.ganancia);
  const r = R.diario.find(d=>d.fecha===diaSel) || {ganancia:0};
  el.innerHTML = `
    <h3>${fdmy(diaSel)} — <span class="${cls(r.ganancia)}">${sf(r.ganancia)} u$s</span></h3>
    <p class="sub">${evs.length} operación${evs.length===1?"":"es"} cerrada${evs.length===1?"":"s"}</p>
    <div class="wrap"><table><thead><tr>
      <th style="cursor:default">Ticker</th><th style="cursor:default">Broker</th>
      <th style="cursor:default">Unid.</th><th style="cursor:default">Costo</th>
      <th style="cursor:default">Cobrado</th><th style="cursor:default">CCL</th>
      <th style="cursor:default">Neto</th><th style="cursor:default">%</th></tr></thead><tbody>
      ${evs.map(e=>`<tr><td class="tk"><span class="sym">${e.ticker}</span></td>
        <td><span class="bk">${(R.posiciones.find(p=>p.broker===e.broker)||{}).broker_nom||e.broker}</span></td>
        <td>${nf(e.unidades,0)}</td><td>u$s ${nf(e.costo)}</td><td>u$s ${nf(e.cobrado)}</td>
        <td>${e.ccl?nf(e.ccl):'<span class="dash">—</span>'}</td>
        <td class="strong">${usd(e.ganancia)}</td>
        <td class="${cls(e.ganancia)}">${e.costo?sf(e.ganancia/e.costo*100,1)+"%":"—"}</td></tr>`).join("")}
    </tbody></table></div>`;
}

function pintarCerradas(){
  const el = $("p-cerradas");
  if(!R || !R.diario.length){ el.innerHTML = vacio("Todavía no hay operaciones cerradas para mostrar."); return; }
  const M = R.metricas;
  const porDia = Object.fromEntries(R.diario.map(r=>[r.fecha,r]));
  const porMes = Object.fromEntries(R.mensual.map(r=>[r.mes,r]));
  const maxAbs = Math.max(...R.diario.map(r=>Math.abs(r.ganancia)))||1;
  const f0=R.diario[0].fecha, f1=R.diario[R.diario.length-1].fecha;
  let y=+f0.slice(0,4), m=+f0.slice(5,7);
  const y1=+f1.slice(0,4), m1=+f1.slice(5,7);
  const bloques=[];
  while(y<y1||(y===y1&&m<=m1)){
    const key=`${y}-${String(m).padStart(2,"0")}`, mr=porMes[key];
    const off=(new Date(Date.UTC(y,m-1,1)).getUTCDay()+6)%7;
    const nd=new Date(Date.UTC(y,m,0)).getUTCDate();
    const cel=Array(off).fill('<div class="d pad"></div>');
    for(let d=1;d<=nd;d++){
      const iso=`${key}-${String(d).padStart(2,"0")}`, r=porDia[iso];
      if(!r){ cel.push(`<div class="d"><span class="dn">${d}</span></div>`); continue; }
      const i=Math.pow(Math.abs(r.ganancia)/maxAbs,.55);
      cel.push(`<button class="d act ${r.ganancia>0?"pos":(r.ganancia<0?"neg":"")} ${diaSel===iso?"sel":""}"
        style="--i:${i.toFixed(3)}" data-f="${iso}" title="${fdmy(iso)}: ${sf(r.ganancia)}">
        <span class="dn">${d}</span><span class="dv">${sf(r.ganancia,0)}</span></button>`);
    }
    bloques.push(`<div class="mes${mr?"":" vacio"}"><div class="mh">
      <span class="mn">${MESES[m-1]} <b>${String(y).slice(2)}</b></span>
      <span class="mt ${mr?cls(mr.ganancia):"dash"}">${mr?sf(mr.ganancia,0):"—"}</span></div>
      <div class="grid">${["L","M","M","J","V","S","D"].map(x=>`<div class="dow">${x}</div>`).join("")}${cel.join("")}</div></div>`);
    m++; if(m===13){m=1;y++;}
  }
  const limpias = R.posiciones.filter(p=>p.categoria==="limpia");
  el.innerHTML = `
    <div class="stats">
      <div class="stat"><span class="sl">Realizado</span><span class="sv ${cls(M.realizado)}">${sf(M.realizado)}</span>
        <span class="ss">en dólares</span></div>
      <div class="stat"><span class="sl">Cerradas</span><span class="sv">${M.n_limpias}</span>
        <span class="ss">de punta a punta</span></div>
      <div class="stat"><span class="sl">Días +</span>
        <span class="sv">${M.dias_positivos}<span style="color:var(--faint);font-size:14px"> / ${M.dias_operados}</span></span>
        <span class="ss">${nf(M.dias_positivos/M.dias_operados*100,0)}%</span></div>
      <div class="stat"><span class="sl">Meses +</span>
        <span class="sv">${M.meses_positivos}<span style="color:var(--faint);font-size:14px"> / ${M.meses_totales}</span></span>
        <span class="ss">${sf(M.realizado/M.meses_totales)} / mes</span></div>
    </div>
    <div class="detalle" id="detalle"></div>
    <div class="meses">${bloques.join("")}</div>
    <div class="leyenda"><span>pérdida</span>
      <span class="sw" style="background:color-mix(in srgb,var(--loss) 72%,var(--surface2))"></span>
      <span class="sw" style="background:color-mix(in srgb,var(--loss) 30%,var(--surface2))"></span>
      <span class="sw" style="background:var(--surface2)"></span>
      <span class="sw" style="background:color-mix(in srgb,var(--gain) 30%,var(--surface2))"></span>
      <span class="sw" style="background:color-mix(in srgb,var(--gain) 72%,var(--surface2))"></span>
      <span>ganancia · u$s</span></div>
    <div class="card"><h3>Detalle por posición</h3>
      <p class="sub">Las ${M.n_limpias} especies compradas y vendidas enteras dentro del período.</p>
      <div class="wrap"><table><thead><tr>
        <th style="cursor:default">Ticker</th><th style="cursor:default">Broker</th>
        <th style="cursor:default">Comprado</th><th style="cursor:default">Vendido</th>
        <th style="cursor:default">Neto</th><th style="cursor:default">%</th></tr></thead><tbody>
        ${limpias.sort((a,b)=>b.realizado-a.realizado).map(p=>`<tr>
          <td class="tk"><span class="sym">${p.ticker}</span></td>
          <td><span class="bk">${p.broker_nom}</span></td>
          <td>u$s ${nf(p.compras)}</td><td>u$s ${nf(p.ventas)}</td>
          <td class="strong">${usd(p.realizado)}</td>
          <td class="${cls(p.realizado)}">${p.compras?sf(p.realizado/p.compras*100,1)+"%":"—"}</td></tr>`).join("")}
      </tbody></table></div></div>`;
  el.querySelectorAll(".d.act").forEach(b=>b.onclick=()=>{
    diaSel = diaSel===b.dataset.f ? null : b.dataset.f;
    el.querySelectorAll(".d.act").forEach(x=>x.classList.toggle("sel", x.dataset.f===diaSel));
    pintarDetalle();
  });
  pintarDetalle();
}

/* --------------------------------------------------------- 3. metricas */
function pintarMetricas(){
  const el = $("p-metricas");
  if(!R){ el.innerHTML = vacio("Importá tus extractos para ver las métricas."); return; }
  const M = R.metricas, DV = R.dividendos;
  const S = R.capital_serie.filter((_,i)=>i%2===0);
  const W=1000,H=170, kmax=Math.max(1,...S.map(p=>p.capital));
  const pts=S.map((p,i)=>[i/(S.length-1)*W, H-p.capital/kmax*(H-14)]);
  const linea=pts.map(p=>p[0].toFixed(1)+","+p[1].toFixed(1)).join(" ");
  const ticks=S.map((p,i)=>{
    if(!p.fecha.endsWith("-01")) return "";
    const mm=+p.fecha.slice(5,7); if(mm%3!==1) return "";
    const x=(i/(S.length-1)*W).toFixed(1);
    return `<line x1="${x}" y1="0" x2="${x}" y2="${H}" class="gl"/><text x="${x}" y="${H-5}" class="gt" transform="translate(3,0)">${MC[mm-1]} ${p.fecha.slice(2,4)}</text>`;
  }).join("");
  const total = M.realizado + M.no_realizado;
  el.innerHTML = `
    <div class="stats">
      <div class="stat"><span class="sl">Precio: neto</span><span class="sv ${cls(total)}">${sf(total)}</span>
        <span class="ss">sin dividendos</span></div>
      <div class="stat"><span class="sl">Dividendos</span><span class="sv ${cls(M.dividendos)}">${sf(M.dividendos)}</span>
        <span class="ss">${M.n_dividendos} cobros</span></div>
      <div class="stat"><span class="sl">Total</span><span class="sv ${cls(total+M.dividendos)}">${sf(total+M.dividendos)}</span>
        <span class="ss">todo junto</span></div>
      <div class="stat"><span class="sl">TNA s/ pico</span><span class="sv ${cls(M.tna_pico)}">${nf(M.tna_pico,2)}%</span>
        <span class="ss">anualizado</span></div>
    </div>
    <div class="card"><h3>Dividendos y renta</h3>
      <p class="sub">Ganar por <b>precio</b> y ganar por <b>renta</b> son cosas distintas.</p>
      <div class="wrap"><table class="plain"><thead><tr><th style="cursor:default">Concepto</th>
        <th style="cursor:default">Cobros</th><th style="cursor:default">Monto</th>
        <th style="cursor:default">¿Suma?</th></tr></thead><tbody>
        <tr><td><b>Dividendos</b> de acciones y CEDEARs</td><td>${M.n_dividendos}</td>
          <td class="${cls(M.dividendos)}">${sf(M.dividendos)}</td><td class="gain">Sí</td></tr>
        <tr><td><b>Renta y amortización</b> de bonos</td><td>${M.n_renta_amort}</td>
          <td class="${cls(M.renta_amort)}">${sf(M.renta_amort)}</td><td class="dash">No</td></tr>
        <tr><td>Retenciones</td><td>—</td>
          <td class="${cls(M.retenciones)}">${sf(M.retenciones)}</td><td class="dash">ya descontadas</td></tr>
      </tbody></table></div>
      <p class="sub" style="margin-top:11px"><b>Por qué la renta de bonos no suma:</b> el broker mezcla el
      <i>cupón</i> (ganancia) con la <i>amortización</i> (tu propio capital volviendo), y los archivos no
      traen el desglose.</p>
      <div class="wrap" style="margin-top:11px"><table class="plain"><tbody>
        ${Object.entries(DV.por_broker).sort((a,b)=>b[1]-a[1]).map(([b,v])=>
          `<tr><td>${b}</td><td class="${cls(v)}">${sf(v)}</td></tr>`).join("")}
        ${Object.entries(DV.por_anio).sort().map(([a,v])=>
          `<tr><td style="padding-left:16px;color:var(--faint)">${a}</td><td class="${cls(v)}">${sf(v)}</td></tr>`).join("")}
      </tbody></table></div>
    </div>
    <div class="card"><h3>Capital inmovilizado</h3>
      <p class="sub">Se recicló ${nf(M.rotacion,1)} veces: la suma de compras (u$s ${nf(M.compras_brutas)})
      no es la plata que hizo falta tener. Esa es el <b>pico</b>.</p>
      <svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" class="curva" role="img" aria-label="Capital inmovilizado">
        ${ticks}<polygon points="0,${H} ${linea} ${W},${H}" class="ar-f"/><polyline points="${linea}" class="ln"/></svg>
      <p class="sub" style="margin:5px 0 0;text-align:right">Pico: u$s ${nf(M.pico)} el ${fdmy(M.fecha_pico)}</p>
    </div>
    <div class="card"><h3>Rendimiento</h3>
      <p class="sub">Sobre lo <b>realizado por precio</b> (u$s ${nf(M.realizado)}), en ${nf(M.anios,2)} años.</p>
      <div class="wrap"><table class="plain"><thead><tr><th style="cursor:default">Capital</th>
        <th style="cursor:default">Monto</th><th style="cursor:default">Rend.</th>
        <th style="cursor:default">TNA</th></tr></thead><tbody>
        <tr><td><b>Pico</b> — la plata que hubo que tener</td><td>u$s ${nf(M.pico)}</td>
          <td class="${cls(M.pct_pico)}">${nf(M.pct_pico,2)}%</td><td class="${cls(M.tna_pico)}">${nf(M.tna_pico,2)}%</td></tr>
        <tr><td>Promedio inmovilizado</td><td>u$s ${nf(M.promedio)}</td>
          <td class="${cls(M.pct_promedio)}">${nf(M.pct_promedio,2)}%</td><td class="${cls(M.tna_promedio)}">${nf(M.tna_promedio,2)}%</td></tr>
        <tr><td>Suma de compras — margen por operación</td><td>u$s ${nf(M.compras_brutas)}</td>
          <td class="${cls(M.realizado)}">${nf(M.compras_brutas?M.realizado/M.compras_brutas*100:0,2)}%</td>
          <td><span class="dash">—</span></td></tr>
      </tbody></table></div>
    </div>
    <div class="card"><h3>Interés compuesto</h3>
      <p class="sub">Si la TNA de ${nf(M.tna_pico,2)}% se sostuviera y reinvirtieras todo, desde el pico de
      u$s ${nf(M.pico)}. Es aritmética, no un pronóstico.</p>
      <div class="wrap"><table class="plain"><thead><tr><th style="cursor:default">Plazo</th>
        <th style="cursor:default">Capital</th><th style="cursor:default">Ganancia</th>
        <th style="cursor:default">Mult.</th></tr></thead><tbody>
        ${[1,2,3,5,10].map(a=>{const f=Math.pow(1+M.tna_pico/100,a);
          return `<tr><td>${a} año${a>1?"s":""}</td><td>u$s ${nf(M.pico*f)}</td>
            <td class="${cls(M.pico*(f-1))}">${sf(M.pico*(f-1))}</td><td>${nf(f,2)}x</td></tr>`;}).join("")}
      </tbody></table></div>
    </div>
    <div class="cav"><p><b>Lo que queda afuera.</b> ${M.n_arrastre} especies vendieron más de lo que habían
    comprado dentro del período: eran tenencias anteriores al primer extracto. Entraron
    u$s ${nf(M.cobrado_sin_costo)} sin costo contra el cual medirlos.</p></div>`;
}

/* ------------------------------------------------------------ 4. datos */
// El panel se redibuja al recalcular, asi que el log se guarda aparte
// para que el resultado de la importacion no desaparezca de la pantalla.
let logImport = [];

function log(lista, msg, clase=""){
  lista.push(`<span class="${clase}">${msg}</span>`);
  const el = $("logimp");
  if(el){ el.hidden = false; el.innerHTML = lista.join("<br>"); el.scrollTop = el.scrollHeight; }
}

function pintarDatos(){
  const el = $("p-datos");
  const fechasCCL = Object.keys(CCL).sort();
  const ult = fechasCCL[fechasCCL.length-1];
  el.innerHTML = `
    <label class="drop" id="drop">
      <span class="t">Importar extractos</span>
      <span class="s">Tocá acá y elegí los archivos de tu broker.<br>
      Acepta <b>.xlsx</b> (Bull Market), <b>.csv</b> (Cocos) y <b>.xls</b> (InvertirOnline).<br>
      Podés seleccionar varios a la vez.</span>
      <input type="file" id="files" multiple accept=".xlsx,.csv,.xls">
    </label>
    <div id="logimp" class="log" ${logImport.length?"":"hidden"}>${logImport.join("<br>")}</div>

    <div class="card"><h3>Tu historial</h3>
      <p class="sub">${LEDGER.length ? `<b>${LEDGER.length}</b> operaciones guardadas en este teléfono` : "Vacío"}
      ${R ? `· ${fdmy(R.ledger.desde)} → ${fdmy(R.ledger.hasta)}` : ""}</p>
      ${R ? `<div class="wrap"><table class="plain"><tbody>${
        Object.entries(R.ledger.por_broker).map(([b,n])=>`<tr><td>${b}</td><td>${n} ops</td></tr>`).join("")
      }</tbody></table></div>` : ""}
      <div class="acciones" style="margin-top:12px">
        <button class="btn sec" id="bkp">Guardar copia</button>
        <label class="btn sec" style="display:inline-block">Restaurar copia
          <input type="file" id="rest" accept=".json"></label>
        <button class="btn sec" id="borrar">Borrar todo</button>
      </div>
      <p class="sub" style="margin:10px 0 0">El historial vive solo acá. Si borrás los datos del navegador
      se pierde, así que conviene guardar una copia de vez en cuando.</p>
    </div>

    <div class="card"><h3>Cotizaciones</h3>
      <p class="sub">CCL más reciente que tenés cargado: <b>${nf(CCL[ult])}</b> del ${fdmy(ult)}.
      Precios de ${Object.keys(PRECIOS).length} especies.</p>
      <div id="estadocot" class="log"></div>
      <div class="acciones" style="margin-top:10px">
        <button class="btn sec" id="actualizar">Actualizar ahora</button>
      </div>
      <p class="sub" style="margin:10px 0 0">Se actualizan solas cada vez que abrís la app.
      Además el repositorio las refresca todos los días, así que aunque abras sin señal
      vas a tener cotizaciones recientes.</p>
    </div>

    <div class="note">
      <p><b>Privacidad.</b> Los archivos se procesan dentro del teléfono. No se suben a ningún servidor
      —esta app no tiene backend— y el historial queda en el almacenamiento local del navegador.</p>
      <p><b>Método.</b> De cada fila se usa siempre la primera fecha en orden cronológico, y el CCL de
      esa misma fecha. La ganancia se imputa al día de cada venta con costo promedio.</p>
    </div>`;

  // importar
  const inp = $("files");
  inp.onchange = async () => {
    logImport = [];
    let nuevas = 0;
    for (const f of inp.files){
      try {
        const ops = await parseArchivo(f);
        const r = fusionar(LEDGER, ops);
        LEDGER = r.historial; nuevas += r.agregadas;
        log(logImport, `✓ ${f.name}: ${ops.length} filas → ${r.agregadas} nuevas, ${r.repetidas} ya estaban`, "ok");
      } catch(e){ log(logImport, `✗ ${f.name}: ${e.message}`, "err"); }
    }
    if(nuevas){
      if(!guardar()) log(logImport, "⚠ No se pudo guardar: el almacenamiento del navegador está lleno", "err");
      log(logImport, `Historial: ${LEDGER.length} operaciones`, "ok");
      recalcular();
      // recien ahora se sabe que especies hay, asi que se piden sus precios
      refrescarCotizaciones();
    } else {
      log(logImport, "No había operaciones nuevas para agregar.");
    }
    inp.value = "";
  };
  const drop = $("drop");
  ["dragover","dragleave","drop"].forEach(ev=>drop.addEventListener(ev, e=>{
    e.preventDefault(); drop.classList.toggle("over", ev==="dragover");
    if(ev==="drop"){ inp.files = e.dataTransfer.files; inp.onchange(); }
  }));

  // copia de seguridad
  $("bkp").onclick = () => {
    const blob = new Blob([JSON.stringify({ledger:LEDGER, ccl:CCL, precios:PRECIOS}, null, 1)],
      {type:"application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `cartera-${hoyISO()}.json`;
    a.click(); URL.revokeObjectURL(a.href);
  };
  $("rest").onchange = async e => {
    try {
      const d = JSON.parse(await e.target.files[0].text());
      if(Array.isArray(d.ledger)) LEDGER = d.ledger;
      if(d.ccl) CCL = {...CCL, ...d.ccl};
      if(d.precios) PRECIOS = {...PRECIOS, ...d.precios};
      guardar(); recalcular();
      alert(`Restaurado: ${LEDGER.length} operaciones`);
    } catch(err){ alert("No pude leer esa copia: "+err.message); }
  };
  $("borrar").onclick = () => {
    if(!confirm("¿Borrar todo el historial de este teléfono? No se puede deshacer.")) return;
    LEDGER = []; localStorage.removeItem(K_LEDGER); recalcular();
  };

  // cotizaciones
  pintarEstadoCotiz();
  $("actualizar").onclick = () => refrescarCotizaciones(true);
}

/* ------------------------------------------------------------- arranque */
arrancar();
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("sw.js").catch(()=>{});
}
