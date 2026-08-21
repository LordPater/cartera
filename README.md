# Mi cartera

App privada para seguir una cartera de inversiones **medida en dólares**, pensada
para el celular.

## Cómo funciona

Cargás los extractos que te da tu broker y la app hace todo el cálculo **dentro
del teléfono**. No hay servidor: los archivos no se suben a ningún lado y el
historial queda en el almacenamiento local del navegador.

Formatos que reconoce:

| Broker | Archivo |
|---|---|
| Bull Market | `Cuenta Corriente *.xlsx` (Pesos, Dólares y Dólares Cable) |
| Cocos Capital | `movimientos_cuenta.csv` |
| InvertirOnline | `OperacionesFinalizadas.xls` (es HTML, no Excel) |

Se pueden importar los mismos archivos las veces que quieras: cada operación
tiene una clave estable, así que nunca se duplica. Y el historial es
**acumulativo**: si el broker deja de mostrar los movimientos viejos —el extracto
de Bull Market tiene una ventana móvil de un año— la app los sigue teniendo.

## Criterios de cálculo

- De las dos fechas de cada fila se usa **siempre la primera en orden
  cronológico**, y el CCL de esa misma fecha.
- La ganancia se imputa al día de cada venta usando **costo promedio**, así que
  una posición con varias compras y ventas queda bien repartida en el tiempo.
- Solo se miden de punta a punta las posiciones compradas *y* vendidas dentro del
  período. Las que arrastran tenencia anterior quedan aparte: se sabe cuánto
  entró, no cuánto había costado.
- Los **dividendos** se cuentan como ganancia. La **renta y amortización** de
  bonos no, porque el broker mezcla el cupón (ganancia) con la amortización
  (capital propio volviendo) y los archivos no traen el desglose.

## Instalar en el celular

Abrí el link, y en el menú del navegador elegí *Agregar a pantalla de inicio*.
Queda como una app y funciona sin internet.

## Cotizaciones

Se actualizan solas, sin intervención:

- **Al abrir la app**, pide el CCL a `mercados.ambito.com` y los precios a
  `data912.com` (BYMA) y `stockanalysis.com` (NYSE/NASDAQ). Las tres permiten
  CORS desde este dominio, así que el teléfono las consulta directo.
- **Todos los días hábiles**, una GitHub Action refresca `src/ccl.json` y
  `src/precios.json` en el repo. Así, aunque abras la app sin señal, los valores
  que trae de fábrica son recientes.

## Copias de seguridad

El historial vive en este teléfono. Desde la pestaña **Datos** podés guardar una
copia en un archivo `.json` y restaurarla después. Conviene hacerlo cada tanto:
si borrás los datos del navegador, se pierde.

## Sin dependencias

No usa ninguna librería externa. Los `.xlsx` se descomprimen con
`DecompressionStream`, que ya viene en el navegador.
