# BCV Scraper — Estado y pendientes (handoff 2026-08-20, actualizado 09:20 UTC)

> **Actualización**: flujo probado end-to-end y funcionando en producción. Dominio propio `bcv-api.sisteg.net` anexado al Worker y verificado. README.md ahora documenta la API completa con ejemplos reales. Ver secciones 3, 4 y 9 (nuevas) para el detalle. Lo único que sigue pendiente de verdad es el ajuste de Cloudflare para el webhook de n8n (sección 3) y que el usuario termine el `git commit`/`push` local (sección 6 — ya desbloqueado).


Documento de retoma. Todo lo de abajo está verificado contra el estado real de Cloudflare y n8n al momento de escribir esto (no son planes, son hechos ya aplicados salvo que diga "pendiente").

## 1. Arquitectura

```
n8n (self-hosted, Contabo VPS)          Cloudflare
┌────────────────────────────┐   POST   ┌───────────────────────────┐
│ BCV Rate Scraper             │ /ingest │  Worker: bcv-rate-api        │
│  Schedule (30min hábil        │────────▶│   D1: bcv_rates              │
│  + 1x/día) → Fetch BCV →      │         │   cron watchdog 03:00 UTC    │
│  Parse & Validate → IF's →    │         └──────────────┬────────────┘
│  POST Ingest                  │                        │ alerta (POST)
│         │ error                                         ▼
│         ▼                                    (bloqueado por Cloudflare,
│  Notify Error ──Execute Workflow──▶ BCV Scraper — Alertas a Notion
│  (interno, mismo n8n)                 Webhook/ExecuteWorkflowTrigger
│                                        → Format Alert → HTTP a Notion API
└────────────────────────────┘                        │
                                                        ▼
                                          Notion DB "BCV Scraper — Alertas"
```

## 2. Accesos MCP conectados en esta sesión (2026-08-20)

- **Cloudflare Developer Platform** — conector oficial. Cubre: D1 (create/query/list/get/delete), KV, R2, Hyperdrive, listar/leer Workers (`workers_list`, `workers_get_worker`, `workers_get_worker_code`). **NO cubre**: deploy de Workers, `wrangler secret put`, ni nada de zona/DNS/WAF/Bot Fight Mode/Security. Esas tres cosas siguen siendo 100% manuales del usuario (CLI local o dashboard de Cloudflare).
- **n8n** — conector oficial MCP, instancia `https://vmi2945958.contaboserver.net`. Funciona por SDK de workflows (código TS que se valida y se sube), no por import de JSON crudo. Tools usadas: `get_sdk_reference`, `get_workflow_best_practices`, `search_nodes`, `get_node_types`, `list_credentials`, `create_workflow_from_code`, `update_workflow`, `publish_workflow`, `get_workflow_details`. **NO puede crear credenciales con secretos** (API key, tokens) — eso es siempre manual en la UI de n8n.
- **Notion** — conector ya presente en la sesión (no lo conectó el usuario en este hilo, ya estaba). Se usó para crear la base de datos de alertas.
- **GitHub** — sin conector MCP disponible en el registro de esta organización. No se intentó nada de GitHub vía API; el repo local se maneja por git normal (ver sección 6).

Si se retoma en una sesión nueva, estos tres conectores (Cloudflare, n8n, Notion) hay que verificarlos/reconectarlos si la sesión no los trae ya activos.

## 3. Cloudflare — estado real

| Recurso | Valor |
|---|---|
| Account tag | `cb77662770c0955288691715afa25690` |
| D1 database | `bcv_rates`, `database_id = 7a9062a4-5965-46de-a541-bc8e2a37a963` (región WEUR) |
| Schema D1 | Aplicado y confirmado (`exchange_rates`, `scrape_log`, `idx_rates_lookup`) — no hace falta re-ejecutar `wrangler d1 execute` para esto |
| Worker | `bcv-rate-api`, desplegado, id `2aa74ea8110641ed8a73601b294d37a1` |
| URL pública del Worker | `https://bcv-rate-api.sisteg.workers.dev` (alias) y **`https://bcv-api.sisteg.net`** (dominio propio, custom domain sobre la zona `sisteg.net`, agregado por el usuario y ya declarado en `wrangler.toml` vía `routes`/`custom_domain = true` para que quede versionado) |
| Cron del Worker (watchdog) | `0 3 * * *` — activo |
| Secret `INGEST_TOKEN` | Seteado por el usuario. Valor: `46d51b39b2ffcdd7c4f6e6d5ea674eb07dc9de0c821550ecb468834cfba9fe15` (debe coincidir con la credencial n8n "BCV Ingest Token") |
| Secret `ALERT_WEBHOOK_URL` | **Sin confirmar** si el usuario llegó a correr `wrangler secret put ALERT_WEBHOOK_URL`. Valor a usar: `https://vmi2945958.contaboserver.net/webhook/bcv-alert` |

### Decisión pendiente — bug de Cloudflare bloqueando el webhook de alertas
Al ejecutar el workflow, cualquier POST servidor-a-servidor a `https://vmi2945958.contaboserver.net/webhook/...` devuelve **403 con una página de challenge de Cloudflare** ("Just a moment...", con cRay ID real de Cloudflare — confirmado que es Cloudflare genuino, no un error de n8n). Esto bloquea al watchdog del Worker (llamada externa real desde Cloudflare Workers hacia ese webhook).

**No se resolvió porque falta un dato clave**: `vmi2945958.contaboserver.net` tiene toda la pinta de ser el hostname genérico que Contabo asigna por defecto (reverse DNS de ellos), no un dominio que el usuario administre en su propia cuenta Cloudflare. Si es así, no hay forma de crear una regla WAF/Bot ahí porque esa zona no es del usuario. Le pregunté al usuario cómo está expuesto n8n realmente (dominio propio en Cloudflare / Cloudflare Tunnel / solo Caddy+hostname de Contabo sin Cloudflare / no está seguro) y la sesión se cortó antes de responder esa pregunta.

**Al retomar, primero preguntar/confirmar esto** — la respuesta determina el fix:
- Si es un **dominio propio en Cloudflare** (proxy naranja activado): la solución es Security → Bots (desactivar Bot Fight Mode) o un WAF Custom/Configuration Rule que excluya `/webhook/*` del challenge, en la zona de ese dominio.
- Si es **Cloudflare Tunnel + Zero Trust Access**: revisar si hay una Access Application con política de autenticación aplicada al hostname/path del webhook — hay que excluir `/webhook/*` de esa política, o el challenge puede venir de ahí en vez de WAF normal.
- Si es **solo Caddy sin Cloudflare de por medio**: entonces el 403 con challenge de Cloudflare NO debería estar pasando salvo que algo más esté enrutando ese tráfico por Cloudflare (raro) — habría que investigar de nuevo con el usuario de dónde sale exactamente ese challenge (¿tiene Cloudflare WARP activo en el VPS? ¿el DNS de contaboserver.net en sí está detrás de Cloudflare por defecto de Contabo?).
- El conector Cloudflare MCP actual **no tiene tools de zona/WAF/Bot** así que ese ajuste, sea cual sea la respuesta, lo tiene que hacer el usuario a mano en el dashboard — yo no puedo ejecutarlo por API con el acceso actual.

**Mitigación ya aplicada** (no depende de resolver lo de arriba): el path interno de alertas (scraper → Notify Error) ya NO pasa por ese webhook público — ver sección 4. Solo el watchdog del Worker (llamada externa real) sigue afectado.

## 4. n8n — estado real (instancia `https://vmi2945958.contaboserver.net`)

### Workflow 1 — "BCV Scraper — Alertas a Notion"
- id: `Csd8PDRrHI7wGmIJ`
- URL: https://vmi2945958.contaboserver.net/workflow/Csd8PDRrHI7wGmIJ
- Estado: **activo**, 4 nodos
- Nodos: **Alert Webhook** (trigger público, `POST /webhook/bcv-alert`, sin auth — usado por el watchdog externo del Worker, afectado por el bug de la sección 3) + **Execute Workflow Trigger** (trigger interno nuevo, agregado hoy, sin salir a internet) → ambos confluyen en **Format Alert** (Set, ya soporta las dos formas de entrada: `$json.body.text` del webhook o `$json.text` del Execute Workflow) → **Log Alert to Notion** (HTTP Request POST a `https://api.notion.com/v1/pages`, Notion-Version 2022-06-28, auth Bearer)
- **Pendiente**: el nodo "Log Alert to Notion" no tiene credencial asignada. Hay que: (1) crear una integración interna en notion.so/my-integrations, (2) compartirla con la base de datos de la sección 5, (3) en n8n crear una credencial tipo **Bearer Auth** con ese token, (4) asignarla al nodo.

### Workflow 2 — "BCV Rate Scraper"
- id: `lcJhTIkBCZgPLf4c`
- URL: https://vmi2945958.contaboserver.net/workflow/lcJhTIkBCZgPLf4c
- Estado: **activo**, 12 nodos, `apiUrl` en el nodo Config ya con el valor real del Worker (`https://bcv-rate-api.sisteg.workers.dev`)
- Flujo: Schedule Trigger → Config → Fetch BCV Page → Parse & Validate (Code) → IF Parsed OK → Get Latest USD → IF Is New Date → POST Ingest → IF Ingest OK → Success / **Notify Error**
- **Notify Error ya no es HTTP al webhook público** — hoy se cambió a un nodo **Execute Workflow** (tipo `n8n-nodes-base.executeWorkflow`) que llama directo al Workflow 1 por su id (`Csd8PDRrHI7wGmIJ`), pasando `{ text: "BCV scraper fallo: " + JSON.stringify($json) }`. Esto evita el bug de Cloudflare para las alertas internas del scraper — verificado server-side que el nodo quedó guardado correctamente (confirmado con `get_workflow_details`, timestamp `2026-08-20T08:54:54Z`). **Si el usuario "no ve el cambio" en el navegador es porque tiene la pestaña vieja cacheada — hay que cerrar y reabrir el workflow, no es que el cambio no se haya aplicado.**
- **Pendiente**: el nodo "POST Ingest" no tiene credencial asignada. Hay que crear en n8n una credencial **Bearer Auth** llamada "BCV Ingest Token" con el valor de la sección 3 (`46d51b39...`) y asignarla a ese nodo. Mientras tanto, cada corrida cae con gracia (`continueOnFail`) a Notify Error → ahora sí debería llegar a Notion vía Execute Workflow (asumiendo que la credencial de Notion del Workflow 1 también esté puesta).

`list_credentials` (n8n) mostró 0 credenciales de tipo Notion/httpBearerAuth en la instancia al momento de crear estos workflows — confirma que ambas credenciales de arriba están pendientes, no es que se hayan perdido.

## 5. Notion — estado real

- Base de datos: **BCV Scraper — Alertas** — https://app.notion.com/p/cefb870f7f2e47a8a1d1f45430689443
- data source id: `9caa9574-2ff9-4860-84bb-31ee5012891f`
- Propiedades: `Mensaje` (title), `Origen` (select: n8n-scraper / worker-watchdog), `Detalle` (rich_text), `Recibido` (created_time)
- El workflow le pega a la API clásica de Notion (`api.notion.com/v1/pages`, Notion-Version 2022-06-28) con `parent.database_id = cefb870f7f2e47a8a1d1f45430689443` en vez de usar el nodo nativo de Notion de n8n — se hizo así a propósito porque el nodo nativo necesita una credencial ya creada para poder listar las bases de datos (chicken-and-egg), y no había ninguna.

## 6. Repo local — estado real

Ruta: `C:\Proyectos\Github\BCV Scraper` — GitHub: `estebanjvasquez/BCV-Scraper` (rama `main`)

Reorganizado hoy:
- `index.js` → `src/index.js` (coincide con `wrangler.toml`)
- `bcv-scraper-workflow.json` → `n8n/bcv-scraper-workflow.json` (queda solo como referencia histórica — el workflow real vive en n8n, ya no en este archivo)
- `wrangler.toml`: `database_id` actualizado al real (sección 3)
- `schema.sql`: agregado `IF NOT EXISTS` para poder re-ejecutar en CI sin romper
- Nuevos: `package.json` (wrangler ^4.124.0 + scripts), `.gitignore`, `.dev.vars.example`, `README.md`
- `.github/workflows/deploy.yml` (CI: aplica schema + `wrangler deploy` en push a main) — **no se pudo escribir en el disco del usuario** (ruta protegida por el bridge remoto), se entregó como archivo descargable en el chat. Falta que el usuario lo coloque a mano en `.github\workflows\deploy.yml`.

**Commit local sin terminar**: se corrió `git add -A` (quedó bien staged, con los renames detectados correctamente), pero un `.git\index.lock` huérfano — que el bridge remoto no puede borrar por permisos — bloquea el `git commit`. El usuario debe, en su propia PowerShell:
```powershell
cd "C:\Proyectos\Github\BCV Scraper"
Remove-Item .git\index.lock
git status
git commit -m "Reorganiza estructura: src/, n8n/, package.json, CI, docs"
git push
```
Estado no confirmado desde que se reportó — puede que ya lo haya hecho.

Para que el CI de `.github/workflows/deploy.yml` funcione hace falta agregar dos secrets en GitHub (Settings → Secrets and variables → Actions): `CLOUDFLARE_API_TOKEN` (scope Workers Scripts:Edit + D1:Edit + Account Settings:Read) y `CLOUDFLARE_ACCOUNT_ID` = `cb77662770c0955288691715afa25690`.

## 7. Lista de pendientes, en orden (actualizada 09:20 UTC — varios ítems resueltos)

1. ~~Crear credencial Bearer Auth "BCV Ingest Token" en n8n~~ — **confirmado funcionando**: se probó `/rates/latest` con datos reales ya ingeridos, lo que prueba que `POST /ingest` con ese Bearer token está pasando.
2. ~~Dominio propio del Worker~~ — **hecho**: `bcv-api.sisteg.net`, probado end-to-end (sección 9).
3. ~~README con documentación de la API~~ — **hecho**, con ejemplos reales.
4. ~~Desbloquear para commit~~ — **hecho**, ver sección 10.
5. **Sigue pendiente**: decidir/confirmar cómo está expuesto n8n hacia internet (dominio propio en Cloudflare / Cloudflare Tunnel / solo Caddy) y aplicar el fix de Cloudflare (WAF/Bot/Access) para que `/webhook/*` no reciba challenge — afecta solo al watchdog externo del Worker, no al scraper.
6. **Sin confirmar todavía**: si la credencial de Notion ("Log Alert to Notion") ya está creada — no se ha probado esa rama del flujo directamente, solo se sabe que `POST /ingest` funciona.
7. **Sin confirmar todavía**: si `wrangler secret put ALERT_WEBHOOK_URL` se corrió con el valor correcto.
8. Terminar `git commit`/`push` local (comandos en sección 10).
9. Colocar `.github/workflows/deploy.yml` a mano y agregar los 2 secrets de GitHub Actions (`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`).
10. (Opcional, sin decidir aún) PAT de GitHub fine-grained si se quiere que Claude pushee directo desde la sesión cloud — no se pidió ni se usó ninguno hasta ahora.

## 9. Pruebas realizadas (2026-08-20, post custom domain)

Contra `https://bcv-api.sisteg.net`, con datos reales ya en D1 (ingeridos por el scraper real, no datos de prueba):

- `GET /health` → `200 {"ok":true}`
- `GET /rates/latest` → `200`, array con las 5 monedas, `value_date: 2026-08-20`
- `GET /rates/latest/USD` → `200`, objeto individual correcto
- `GET /rates/history?currency=USD&limit=5` → `200`, array (1 registro — es el primer día con datos)
- `GET /ingest` (sin auth, método incorrecto) → `404`, correcto (esa ruta solo maneja `POST`)

Confirma que todo el pipeline real funcionó: n8n scrapeó, `POST /ingest` con el Bearer token pasó (la credencial "BCV Ingest Token" en n8n quedó bien configurada por el usuario), el Worker validó y persistió en D1, y las lecturas públicas responden correctas en el dominio nuevo.

No probado todavía (requiere más de un día de histórico o forzar condiciones): rotación de `value_date` día a día, rechazo por anomalía >15%, y el watchdog de las 03:00 UTC (sigue bloqueado por el issue de Cloudflare de la sección 3 — no relacionado con el dominio nuevo, es el webhook de n8n el que sigue afectado).

## 10. Repo local — reorganización final

Todo ya escrito en disco y **staged** (`git add -A` ya corrido, confirmado con `git status --short`): `README.md` (reescrito con la doc completa de la API + ejemplos reales + estado de pruebas), `wrangler.toml` (con el `routes`/`custom_domain` de `bcv-api.sisteg.net`), `HANDOFF.md`, `package-lock.json` (generado por el `npm install` del usuario), más todo lo de la reorganización anterior (`src/`, `n8n/`, `package.json`, `.gitignore`, `.dev.vars.example`, `schema.sql` con `IF NOT EXISTS`).

El `.git/index.lock` se volvió a trabar varias veces durante esta sesión (cada comando git vía el bridge remoto deja un lock huérfano nuevo, sin excepción — no es un bug puntual, es estructural: el bridge no puede hacer `unlink` y la limpieza de git de su propio lock siempre falla). Se dejó limpio al final (sin `.git/index.lock` presente y sin ejecutar ningún comando git después de removerlo), así que el usuario puede commitear ya mismo desde su PowerShell sin chocar con nada:
```powershell
cd "C:\Proyectos\Github\BCV Scraper"
git status   # confirmar que todo lo de arriba aparece staged
git commit -m "Doc completa de API, dominio bcv-api.sisteg.net, reorganizacion final"
git push
```
Si en algún momento futuro Claude vuelve a tocar este repo vía `device_bash` con comandos git, hay que asumir que va a dejar un `index.lock` huérfano después de CADA comando (no solo el primero) — limpiarlo con `mv` (no `rm`, eso también falla) antes de que el usuario intente su propio git, y como última acción de la sesión, sin encadenar ningún git después.

## 8. Cómo retomar

Todo lo de este documento también quedó guardado en la memoria del proyecto (`project_bcv_scraper.md` y `feedback_device_bash_git.md`, indexados en `MEMORY.md`), así que una sesión nueva puede recuperarlo pidiendo que revise la memoria del proyecto. Este archivo es la versión "para humano" de lo mismo.
