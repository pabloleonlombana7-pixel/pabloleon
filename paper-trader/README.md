# Paper trader (modo simulado)

Ejecuta el ciclo de trading del agente Modern Stoic **sin dinero real**: usa datos de DexScreener, el criterio de OpenAI y cotizaciones reales de Jupiter, pero las compras y ventas se simulan sobre un saldo virtual. No necesita instalar el monorepo de elizaOS.

Es seguro por construcción: el empaquetado sustituye el acceso a la cartera y a Twitter por módulos que fallan, así que no puede firmar transacciones ni publicar tweets, aunque se configure mal.

## Requisitos

- [Node.js](https://nodejs.org) 20.12 o superior (recomendado 22 LTS).
- Una clave de API de OpenAI con saldo (https://platform.openai.com/api-keys). Cada ciclo cuesta céntimos.

## Instalación

Desde la carpeta `paper-trader` del repositorio:

```bash
npm install
```

Copia la configuración de ejemplo y pon tu clave de OpenAI en `OPENAI_API_KEY`:

```bash
cp .env.example .env
```

En Windows (PowerShell) usa `Copy-Item .env.example .env`. El archivo `.env` no se sube a git.

## Uso

| Comando | Qué hace |
|---|---|
| `npm start` | Bucle continuo: un ciclo ahora y luego uno cada `TRADING_COOLDOWN_MINUTES` (60). Ctrl+C para parar. |
| `npm run once` | Un solo ciclo y un informe. |
| `npm run report` | Solo el informe: saldo, valor actual de cada posición y resultado total. |

Cada ciclo revisa las posiciones abiertas (stop-loss a 0,5x, toma de ganancias escalonada a 2x/4x/8x/16x), busca candidatos y deja que el modelo elija hasta 2 compras.

El estado se guarda en `data/paper.json` y sobrevive a reinicios; si paras y vuelves a arrancar, respeta el tiempo entre ciclos. Cada ciclo añade una fila a `data/equity.csv` (ábrelo con Excel o Google Sheets para ver la evolución). Para empezar de cero, borra la carpeta `data`.

## Dejarlo funcionando varios días

El ordenador tiene que estar encendido y sin suspenderse. Opciones:

- **Windows:** deja la ventana de la terminal abierta con `npm start` y desactiva la suspensión, o crea una tarea en el Programador de tareas que ejecute `npm run once` cada hora en esta carpeta.
- **macOS / Linux:** `npm start` en una terminal, o una entrada de cron cada hora:
  `0 * * * * cd /ruta/a/paper-trader && npm run once >> data/log.txt 2>&1`
- **Servidor (VPS):** igual que Linux; usa `tmux` o `pm2` para que siga tras cerrar la sesión.

## Cómo leer los resultados

Tras unos días, compara el **Total** del informe con el saldo inicial (`TRADING_PAPER_SOL`). Ten en cuenta que comprar y vender cuesta en torno a un 1–2 % por las comisiones y el deslizamiento; un resultado plano o negativo significa que la estrategia no aporta nada. No pases a dinero real sin una ventaja clara y sostenida.
