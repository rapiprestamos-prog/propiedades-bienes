#!/usr/bin/env python3
"""Convierte MIFI_INFORME_INTEGRAL_DE_PROPIEDADES (Excel) al paquete MIFI_DATOS_V2 que carga el dashboard.
Uso: python3 -I convertir_mifi.py <excel.xlsx> <salida.json>
 - ORIGEN       → cartera activa
 - VENDIDOS MFI → vendidas (con precio de venta)
 - El enlace del PDF de valoración sale del hipervínculo de la columna "Enlace valoración"."""
import sys, json, datetime, re, openpyxl

src, out = sys.argv[1], sys.argv[2]
wb = openpyxl.load_workbook(src, data_only=True)

def txt(v):
    if v is None: return None
    s = re.sub(r"\s+", " ", str(v)).strip()
    return s or None
def num(v):
    if v is None or v == "": return None
    if isinstance(v, (int, float)): return round(float(v), 2)
    s = str(v).replace(",", "").replace("$", "").strip()
    try: return round(float(s), 2)
    except ValueError: return None
def fecha(v):
    if v is None or v == "": return None
    if isinstance(v, (datetime.datetime, datetime.date)): return v.strftime("%Y-%m-%d")
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})", str(v).strip())
    if m: return m.group(0)
    m = re.match(r"^(\d{1,2})/(\d{1,2})/(\d{4})$", str(v).strip())
    if m: return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"
    return txt(v)
def finca(v):
    if isinstance(v, float) and v.is_integer(): v = int(v)
    if isinstance(v, int): return v
    s = txt(v)
    return int(s) if s and s.isdigit() else s

def leer(hoja, grupo):
    ws = wb[hoja]; rows = list(ws.iter_rows())
    hi = next(i for i, r in enumerate(rows) if any(c.value == "N° de Finca" for c in r))
    H = {}
    for j, c in enumerate(rows[hi]):
        k = txt(c.value)
        if k and k not in H: H[k.lower()] = j
    def col(r, *nombres):
        for n in nombres:
            j = H.get(n.lower())
            if j is not None and j < len(r): return r[j]
        return None
    salida = []
    for r in rows[hi + 1:]:
        cf = col(r, "N° de Finca")
        if cf is None or cf.value in (None, ""): continue
        link = col(r, "Enlace valoración")
        f = {
            "finca": finca(cf.value), "grupo": grupo,
            "cedente": txt(col(r, "Cedida /Hipotecada").value) if col(r, "Cedida /Hipotecada") else None,
            "vendidoA": txt(col(r, "VENDIDO A").value) if col(r, "VENDIDO A") else None,
            "prov": txt(col(r, "Provincia").value), "corr": txt(col(r, "Corregimiento").value),
            "tipo": txt(col(r, "Descripcion").value),
            "ventaR": num(col(r, "Venta Rapida").value), "merc": num(col(r, "Mercado").value),
            "vlibros": num(col(r, "Valor en libros").value), "vs": num(col(r, "Valor sugerido").value),
            "precioVenta": num(col(r, "PRECIO DE VENTA").value) if col(r, "PRECIO DE VENTA") else None,
            "lanz": txt(col(r, "Lanzamiento").value) if col(r, "Lanzamiento") else None,
            "estado": txt(col(r, "Estado Actual").value),
            "fa": fecha(col(r, "Fecha de avalúo").value),
            "obs": txt(col(r, "Observacion").value),
            "ea": txt(col(r, "Estado de avalúo (2 años)").value) if col(r, "Estado de avalúo (2 años)") else None,
            "enlace": (link.hyperlink.target if link is not None and link.hyperlink else None),
            "fe": None, "fv": None, "tasa": None, "situacion": None,
        }
        if grupo == "vendida" and not f["estado"]: f["estado"] = "VENDIDA"
        salida.append(f)
    return salida

activas = leer("ORIGEN", "activa")
vendidas = leer("VENDIDOS MFI", "vendida")
pkg = {"formato": "MIFI_DATOS_V2", "origen": "MIFI_INFORME_INTEGRAL_DE_PROPIEDADES_V16.xlsx (ORIGEN + VENDIDOS MFI)",
       "generado": datetime.datetime.now().strftime("%Y-%m-%d %H:%M"), "fincas": activas + vendidas}
json.dump(pkg, open(out, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
print(f"{len(activas)} activas · {len(vendidas)} vendidas · {sum(1 for f in pkg['fincas'] if f['enlace'])} con PDF")
