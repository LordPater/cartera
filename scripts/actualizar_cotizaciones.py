"""
Refresca src/ccl.json y src/precios.json. Lo corre GitHub Actions todos los dias
habiles, para que la app tenga cotizaciones recientes aunque el telefono abra sin
conexion. Solo usa la biblioteca estandar.
"""
import json
import urllib.request
from datetime import date, timedelta
from pathlib import Path

BASE = Path(__file__).resolve().parent.parent
UA = {"User-Agent": "Mozilla/5.0 (compatible; cartera-app/1.0)"}

# Bonos y ONs cotizan por cada 100 de valor nominal.
POR_100 = {
    "AE38", "AL29", "AL30", "AL35", "AL41", "AO27", "AO28", "AO29", "AN29", "BDC28",
    "BPOA7", "BPOB7", "BPOC7", "BPOD7", "BPOA8", "BPOB8", "BC37D", "GD29", "GD30",
    "GD35", "GD38", "GD41", "GD46", "TVPP", "DICP", "PARP", "CUAP",
}


# Obligaciones negociables conocidas (tambien cotizan por 100 nominales).
# Lista explicita en vez de "termina en O": hay acciones que terminan en O.
ONS = set("IRCFO IRCJO IRCNO IRCOO IRCPO IRCQO CAC5O CACBO CACDO YMCIO YMCJO YMCQO YMCTO YMCXO YMCYO YMCZO MGCHO MGCJO MGCMO MGCNO MGCOO MGCQO MGCRO MGCTO MTCGO MTC2O TLC1O TLC5O TLCDO TLCMO TLCOO TLCPO TLCQO TLCTO TLCUO TLCVO TLCWO YCA6O CP32O CP36O CP37O CP38O CP40O RCCMO RCCRO NDT25 PNDCO PECNO".split())


def es_por_100(tk):
    return tk in POR_100 or tk in ONS


def bajar(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=45) as r:
        return json.loads(r.read().decode("utf-8", "replace"))


def num_ar(v):
    return float(str(v).replace(".", "").replace(",", "."))


def actualizar_ccl():
    """Ultimos 30 dias de CCL; se fusionan con la serie historica ya guardada."""
    p = BASE / "src" / "ccl.json"
    ccl = json.loads(p.read_text(encoding="utf-8"))
    antes = len(ccl)
    hoy = date.today()
    desde = hoy - timedelta(days=30)
    f = lambda d: d.strftime("%d-%m-%Y")
    url = f"https://mercados.ambito.com/dolarrava/cl/historico-general/{f(desde)}/{f(hoy)}"
    try:
        datos = bajar(url)
    except Exception as e:
        print(f"CCL: fallo la descarga ({e}); se deja la serie como estaba")
        return
    for fila in datos[1:]:
        try:
            fecha, valor = fila[0], fila[1]
            if not fecha or not valor:
                continue
            d, m, y = str(fecha).split("/")
            ccl[f"{y}-{m}-{d}"] = num_ar(valor)
        except Exception:
            continue
    p.write_text(json.dumps(ccl, sort_keys=True, indent=0), encoding="utf-8")
    ult = max(ccl)
    print(f"CCL: {antes} -> {len(ccl)} fechas (ultima: {ult} = {ccl[ult]})")


def actualizar_precios():
    """Precios de las especies que ya figuran en el archivo, para no inflarlo."""
    p = BASE / "src" / "precios.json"
    doc = json.loads(p.read_text(encoding="utf-8"))
    precios = doc.get("precios", {})
    quiero = set(precios)

    nuevos, fallas = {}, []
    for ep in ("arg_cedears", "arg_stocks", "arg_bonds", "arg_corp", "arg_notes"):
        try:
            datos = bajar(f"https://data912.com/live/{ep}")
        except Exception as e:
            fallas.append(f"{ep}: {e}")
            continue
        for row in datos:
            s, c = row.get("symbol"), row.get("c")
            if s in quiero and s not in nuevos and c:
                nuevos[s] = {"p": c / 100 if es_por_100(s) else c, "m": "ARS"}

    for tk in [t for t in quiero if t.endswith(".US")]:
        try:
            j = bajar(f"https://stockanalysis.com/api/quotes/s/{tk[:-3]}")
            if j.get("data", {}).get("p"):
                nuevos[tk] = {"p": j["data"]["p"], "m": "USD"}
        except Exception as e:
            fallas.append(f"{tk}: {e}")

    if not nuevos:
        print("precios: no se pudo actualizar ninguno; se deja el archivo como estaba")
        return

    precios.update(nuevos)
    doc.update({
        "fecha": date.today().isoformat(),
        "fuente": "data912.com + stockanalysis.com",
        "precios": precios,
    })
    p.write_text(json.dumps(doc, indent=1, sort_keys=True), encoding="utf-8")
    print(f"precios: {len(nuevos)} actualizados de {len(quiero)}")
    if fallas:
        print("  con fallas parciales:", "; ".join(fallas[:5]))


if __name__ == "__main__":
    actualizar_ccl()
    actualizar_precios()
