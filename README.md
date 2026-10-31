# Propiedades Bienes

Dashboard de la cartera de fincas (activas, vendidas y casos legales) con usuarios, roles e historial de cambios.

- **Página:** `index.html` (se publica con GitHub Pages). No trae datos: los pide al servidor después de entrar.
- **Servidor y base de datos:** Google Apps Script (`apps-script/Code.gs`) sobre una hoja de Google.
- Las contraseñas se guardan **cifradas** (sal + SHA-256 repetido) y se verifican en el servidor.

## Puesta en marcha (una sola vez)

1. **Hoja de Google.** Crea una hoja nueva en Google Drive (por ejemplo "Propiedades Bienes — base"). No la compartas: el dashboard entra por el script.
2. **Apps Script.** En la hoja: **Extensiones → Apps Script**. Borra lo que trae `Código.gs`, pega todo `apps-script/Code.gs` y guarda.
   - En la hoja aparece el menú **Propiedades Bienes → Instalar / crear administrador** (recarga la hoja si no aparece). Ejecútalo y acepta los permisos.
   - Te muestra **usuario `admin` y una contraseña temporal**. Anótala: no se vuelve a mostrar (si la pierdes: menú → *Nueva contraseña temporal para el administrador*).
3. **Publicar el script.** En Apps Script: **Implementar → Nueva implementación → Tipo: Aplicación web**.
   - *Ejecutar como:* **Yo** · *Quién tiene acceso:* **Cualquier usuario**.
   - Copia la URL que termina en **`/exec`**.
4. **Conectar la página.** En `index.html` busca `PEGAR_AQUI_LA_URL_DEL_APPS_SCRIPT` y reemplázalo por esa URL. Guarda y sube el cambio a GitHub.
5. **GitHub Pages.** En el repo: **Settings → Pages → Branch: `main` / root → Save**. En un minuto queda en `https://rapiprestamos-prog.github.io/propiedades-bienes/`.
6. **Primer ingreso.** Entra con `admin` y la contraseña temporal; te pedirá crear la tuya (mínimo 10 caracteres, letras y números).
7. **Cargar las fincas.** Pestaña **Usuarios y accesos → Carga completa de datos** → elige el archivo `datos_iniciales_v16.json` (se entrega aparte, **no se sube a GitHub** porque tiene datos de clientes).
8. **Tu equipo.** En **Usuarios y accesos** crea a cada persona con su rol; a cada una le sale una contraseña temporal que debe cambiar al entrar.

> Cada vez que cambies `Code.gs`: **Implementar → Gestionar implementaciones → editar (lápiz) → Versión: Nueva → Implementar**. Así la URL no cambia.

## Roles

| Rol | Puede |
|---|---|
| Administrador | Todo, más usuarios, revertir cambios y carga completa de datos |
| Edición (todo) | Editar fincas y casos legales |
| Edición · bienes reposeídos | Solo fincas |
| Edición · casos legales | Solo casos legales |
| Solo lectura | Ver |

## Seguridad

- 5 intentos fallidos → bloqueo de 15 minutos (también al cambiar la contraseña).
- Contraseña temporal: vence a las 72 h y obliga a crear una personal.
- Al cambiar o restablecer una contraseña, o al desactivar a alguien, se cierran sus sesiones.
- La sesión queda abierta en el navegador hasta "Cerrar sesión" (30 días sin uso la vencen).
- Cada ingreso, salida, bloqueo y cambio queda en las pestañas **Accesos** e **Historial** de la hoja.

## Herramientas

- `herramientas/convertir_excel.py`: convierte el Excel *MIFI_INFORME_INTEGRAL_DE_PROPIEDADES* (hojas ORIGEN y VENDIDOS MFI) al archivo que se carga en el paso 7:
  `python3 herramientas/convertir_excel.py INFORME.xlsx datos.json`
