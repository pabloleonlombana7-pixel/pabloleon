import * as fs from "fs";
import * as path from "path";
import BigNumber from "bignumber.js";
import { runTradingCycle } from "../packages/plugin-solana/src/actions/purchaseRecommendedTokens.ts";

const SOL_MINT = "So11111111111111111111111111111111111111112";

try {
  (process as any).loadEnvFile?.(".env");
} catch {
  console.warn("No .env file found, using environment variables only.");
}

if ((process.env.TRADING_MODE || "").toLowerCase() === "live") {
  console.error("The paper trader never trades real funds. Remove TRADING_MODE=live from .env.");
  process.exit(1);
}

const settings: Record<string, string | undefined> = {
  ...process.env,
  TRADING_MODE: "paper",
  TRADING_STATE_FILE: process.env.TRADING_STATE_FILE || path.join("data", "paper.json"),
};
const runtime: any = { agentId: "paper-trader", getSetting: (k: string) => settings[k] };
const stateFile = settings.TRADING_STATE_FILE!;
const equityCsv = path.join(path.dirname(stateFile), "equity.csv");
const jupiter = (settings.JUPITER_API_URL || "https://lite-api.jup.ag/swap/v1").replace(/\/$/, "");
const startSol = Number(settings.TRADING_PAPER_SOL || 1);

async function positionValueSol(pos: any): Promise<number | null> {
  const amount = new BigNumber(pos.quantity).multipliedBy(new BigNumber(10).pow(pos.decimals)).integerValue(BigNumber.ROUND_DOWN);
  if (amount.lte(0)) return 0;
  try {
    const r = await fetch(`${jupiter}/quote?inputMint=${pos.tokenCA}&outputMint=${SOL_MINT}&amount=${amount.toFixed(0)}&slippageBps=100`);
    const q = await r.json();
    return q?.outAmount ? Number(q.outAmount) / 1e9 : null;
  } catch {
    return null;
  }
}

async function report(writeCsv: boolean) {
  if (!fs.existsSync(stateFile)) {
    console.log("No paper trades yet.");
    return;
  }
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  let positionsSol = 0;
  const rows: string[] = [];
  for (const pos of Object.values<any>(state.positions)) {
    const value = await positionValueSol(pos);
    const cost = pos.costBasisSOL * pos.quantity;
    if (value === null) {
      rows.push(`  ${pos.ticker.padEnd(10)} sin precio (valor de compra ${cost.toFixed(4)} SOL)`);
      positionsSol += cost;
      continue;
    }
    positionsSol += value;
    rows.push(`  ${pos.ticker.padEnd(10)} ${value.toFixed(4)} SOL  (${(value / cost).toFixed(2)}x, desde ${pos.openedAt.slice(0, 16)})`);
  }
  const equity = state.paperSol + positionsSol;
  const pct = ((equity / startSol - 1) * 100).toFixed(2);
  console.log(`\n--- Informe ${new Date().toISOString().slice(0, 16)} ---`);
  console.log(`Saldo libre: ${state.paperSol.toFixed(4)} SOL | Posiciones: ${positionsSol.toFixed(4)} SOL`);
  console.log(`Total: ${equity.toFixed(4)} SOL (${pct}% sobre ${startSol} SOL) | PnL realizado: ${state.realizedPnlSol.toFixed(4)} SOL`);
  rows.forEach((r) => console.log(r));

  if (writeCsv) {
    if (!fs.existsSync(equityCsv)) fs.writeFileSync(equityCsv, "time,free_sol,positions_sol,equity_sol,realized_pnl_sol,open_positions\n");
    fs.appendFileSync(
      equityCsv,
      [new Date().toISOString(), state.paperSol, positionsSol, equity, state.realizedPnlSol, Object.keys(state.positions).length]
        .map((v) => (typeof v === "number" && !Number.isInteger(v) ? v.toFixed(6) : v))
        .join(",") + "\n"
    );
  }
}

async function cycle() {
  try {
    await runTradingCycle(runtime);
  } catch (err) {
    const cause = (err as any)?.cause;
    console.error("Cycle failed:", err instanceof Error ? err.message : err, cause ? `(${cause.code || cause.message || cause})` : "");
  }
  await report(true);
}

const args = process.argv.slice(2);
if (args.includes("--report")) {
  await report(false);
} else if (args.includes("--once")) {
  await cycle();
} else {
  const minutes = Number(settings.TRADING_COOLDOWN_MINUTES) > 0 ? Number(settings.TRADING_COOLDOWN_MINUTES) : 60;
  console.log(`Paper trader running: one cycle every ${minutes} min. Press Ctrl+C to stop.`);
  await cycle();
  setInterval(cycle, minutes * 60_000);
}
