import { Action, IAgentRuntime, Memory, State } from "@elizaos/core";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import { getWalletKey } from "../keypairUtils.ts";
import BigNumber from "bignumber.js";
import { Scraper } from "agent-twitter-client";
import * as fs from "fs";
import * as path from "path";

/*
 * Trading cycle for the Modern Stoic agent.
 *
 * SAFETY: the agent runs in PAPER mode unless TRADING_MODE=live is set.
 * In paper mode it uses real market data and real Jupiter quotes, but never
 * signs or sends a transaction and never tweets. Fills are simulated from the
 * quote and tracked against a virtual SOL balance (TRADING_PAPER_SOL).
 *
 * Settings (all optional, read through runtime.getSetting):
 *   TRADING_MODE                    "live" to trade real funds; anything else = paper
 *   SOLANA_RPC_URL / RPC_URL        RPC endpoint (default: public mainnet)
 *   JUPITER_API_URL                 default https://lite-api.jup.ag/swap/v1
 *   TRADING_OPENAI_MODEL            default gpt-4o
 *   TRADING_TOKEN_SOURCE            "dexscreener" (default, free, no key) or "birdeye"
 *   TRADING_MIN_PAIR_AGE_HOURS      ignore pairs younger than this (default 24, DexScreener)
 *   TRADING_MAX_POSITION_FRACTION   max share of SOL balance per buy (default 0.2)
 *   TRADING_MAX_BUYS_PER_CYCLE      default 2
 *   TRADING_MIN_LIQUIDITY_USD       default 50000
 *   TRADING_MIN_VOLUME_USD          default 100000
 *   TRADING_SLIPPAGE_BPS            default 100
 *   TRADING_SOL_RESERVE             SOL kept back for fees (default 0.02)
 *   TRADING_COOLDOWN_MINUTES        minimum time between cycles (default 60)
 *   TRADING_PAPER_SOL               starting virtual balance in paper mode (default 1)
 *   TRADING_STATE_FILE              default data/stoic-trading-<mode>.json
 *   TRADING_TWEETS_ENABLED          "true" to tweet trades (live mode only)
 */

const SOL_MINT = "So11111111111111111111111111111111111111112";

interface IPosition {
  ticker: string;
  tokenCA: string;
  costBasisSOL: number; // SOL paid per token
  quantity: number; // tokens currently held (UI units)
  decimals: number;
  partialSales: number;
  openedAt: string;
}

interface ITradingState {
  mode: "paper" | "live";
  paperSol: number;
  positions: Record<string, IPosition>;
  realizedPnlSol: number;
  lastCycleAt: number;
  lastTweetContent: string | null;
}

interface IConfig {
  live: boolean;
  rpcUrl: string;
  jupiterUrl: string;
  openAiApiKey: string;
  openAiModel: string;
  birdeyeApiKey: string;
  tokenSource: "dexscreener" | "birdeye";
  minPairAgeHours: number;
  maxPositionFraction: number;
  maxBuysPerCycle: number;
  minLiquidityUsd: number;
  minVolumeUsd: number;
  slippageBps: number;
  solReserve: number;
  cooldownMs: number;
  paperSol: number;
  stateFile: string;
  tweetsEnabled: boolean;
}

interface ICandidate {
  symbol: string;
  address: string;
  liquidityUsd: number;
  volume24hUsd: number;
  priceUsd: number;
  rank: number | null;
}

let cycleRunning = false;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function numSetting(runtime: IAgentRuntime, key: string, fallback: number): number {
  const raw = runtime.getSetting(key);
  const n = raw === undefined || raw === null || raw === "" ? NaN : Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function loadConfig(runtime: IAgentRuntime): IConfig {
  const live = (runtime.getSetting("TRADING_MODE") || "").toLowerCase() === "live";
  const mode = live ? "live" : "paper";
  return {
    live,
    rpcUrl:
      runtime.getSetting("SOLANA_RPC_URL") ||
      runtime.getSetting("RPC_URL") ||
      "https://api.mainnet-beta.solana.com",
    jupiterUrl: (runtime.getSetting("JUPITER_API_URL") || "https://lite-api.jup.ag/swap/v1").replace(/\/$/, ""),
    openAiApiKey: runtime.getSetting("OPENAI_API_KEY") || "",
    openAiModel: runtime.getSetting("TRADING_OPENAI_MODEL") || "gpt-4o",
    birdeyeApiKey: runtime.getSetting("BIRDEYE_API_KEY") || "",
    tokenSource:
      (runtime.getSetting("TRADING_TOKEN_SOURCE") || "").toLowerCase() === "birdeye" ? "birdeye" : "dexscreener",
    minPairAgeHours: numSetting(runtime, "TRADING_MIN_PAIR_AGE_HOURS", 24),
    maxPositionFraction: Math.min(Math.max(numSetting(runtime, "TRADING_MAX_POSITION_FRACTION", 0.2), 0), 1),
    maxBuysPerCycle: Math.max(0, Math.floor(numSetting(runtime, "TRADING_MAX_BUYS_PER_CYCLE", 2))),
    minLiquidityUsd: numSetting(runtime, "TRADING_MIN_LIQUIDITY_USD", 50_000),
    minVolumeUsd: numSetting(runtime, "TRADING_MIN_VOLUME_USD", 100_000),
    slippageBps: Math.max(1, Math.floor(numSetting(runtime, "TRADING_SLIPPAGE_BPS", 100))),
    solReserve: numSetting(runtime, "TRADING_SOL_RESERVE", 0.02),
    cooldownMs: numSetting(runtime, "TRADING_COOLDOWN_MINUTES", 60) * 60_000,
    paperSol: numSetting(runtime, "TRADING_PAPER_SOL", 1),
    stateFile: runtime.getSetting("TRADING_STATE_FILE") || path.join("data", `stoic-trading-${mode}.json`),
    tweetsEnabled: live && (runtime.getSetting("TRADING_TWEETS_ENABLED") || "").toLowerCase() === "true",
  };
}

// ---------------------------------------------------------------------------
// Persistent state (positions survive restarts)
// ---------------------------------------------------------------------------

function loadState(cfg: IConfig): ITradingState {
  const fresh: ITradingState = {
    mode: cfg.live ? "live" : "paper",
    paperSol: cfg.paperSol,
    positions: {},
    realizedPnlSol: 0,
    lastCycleAt: 0,
    lastTweetContent: null,
  };
  try {
    if (fs.existsSync(cfg.stateFile)) {
      const parsed = JSON.parse(fs.readFileSync(cfg.stateFile, "utf8"));
      if (parsed.mode !== fresh.mode) {
        throw new Error(`State file ${cfg.stateFile} belongs to ${parsed.mode} mode, not ${fresh.mode}`);
      }
      return { ...fresh, ...parsed };
    }
  } catch (err) {
    if (String(err).includes("belongs to")) throw err;
    console.error(`Could not read trading state from ${cfg.stateFile}, starting fresh:`, err);
  }
  return fresh;
}

function saveState(cfg: IConfig, state: ITradingState) {
  fs.mkdirSync(path.dirname(path.resolve(cfg.stateFile)), { recursive: true });
  const tmp = `${cfg.stateFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, cfg.stateFile);
}

// ---------------------------------------------------------------------------
// External APIs
// ---------------------------------------------------------------------------

async function birdeyeGet(cfg: IConfig, url: string): Promise<any> {
  const response = await fetch(url, {
    method: "GET",
    headers: { accept: "application/json", "X-API-KEY": cfg.birdeyeApiKey, "x-chain": "solana" },
  });
  if (!response.ok) {
    throw new Error(`Birdeye ${url} failed with status ${response.status}`);
  }
  return response.json();
}

async function openAiChat(cfg: IConfig, prompt: string, temperature: number, maxTokens: number, json: boolean): Promise<string> {
  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cfg.openAiApiKey}` },
    body: JSON.stringify({
      model: cfg.openAiModel,
      messages: [
        { role: "system", content: "You are a disciplined, risk-averse crypto trading assistant." },
        { role: "user", content: prompt },
      ],
      temperature,
      max_tokens: maxTokens,
      ...(json ? { response_format: { type: "json_object" } } : {}),
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI API Error: ${response.status} ${await response.text()}`);
  }
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("Empty response from OpenAI API.");
  return content;
}

interface IQuote {
  raw: any;
  inAmount: BigNumber;
  outAmount: BigNumber;
  priceImpactPct: number;
}

async function getQuote(cfg: IConfig, inputMint: string, outputMint: string, amountBaseUnits: BigNumber): Promise<IQuote | null> {
  const url =
    `${cfg.jupiterUrl}/quote?inputMint=${inputMint}&outputMint=${outputMint}` +
    `&amount=${amountBaseUnits.toFixed(0)}&slippageBps=${cfg.slippageBps}`;
  const response = await fetch(url);
  const data = await response.json().catch(() => null);
  // Jupiter's quote response carries inAmount/outAmount at the top level.
  if (!response.ok || !data || data.error || !data.outAmount) {
    console.error("Jupiter quote failed:", response.status, data);
    return null;
  }
  return {
    raw: data,
    inAmount: new BigNumber(data.inAmount),
    outAmount: new BigNumber(data.outAmount),
    priceImpactPct: Number(data.priceImpactPct || 0) * 100,
  };
}

/** Builds, signs, sends and confirms a Jupiter swap. Returns the signature, or null on failure. */
async function executeSwap(runtime: IAgentRuntime, cfg: IConfig, connection: Connection, quote: IQuote): Promise<string | null> {
  const { keypair } = await getWalletKey(runtime, true);
  const swapResponse = await fetch(`${cfg.jupiterUrl}/swap`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      quoteResponse: quote.raw,
      userPublicKey: keypair.publicKey.toBase58(),
      wrapAndUnwrapSol: true,
      dynamicComputeUnitLimit: true,
      prioritizationFeeLamports: "auto",
    }),
  });
  const swapData = await swapResponse.json().catch(() => null);
  if (!swapResponse.ok || !swapData?.swapTransaction) {
    console.error("Jupiter swap build failed:", swapData);
    return null;
  }

  const transaction = VersionedTransaction.deserialize(Buffer.from(swapData.swapTransaction, "base64"));
  transaction.sign([keypair]);

  let signature: string;
  try {
    signature = await connection.sendTransaction(transaction, {
      skipPreflight: false,
      maxRetries: 3,
      preflightCommitment: "confirmed",
    });
  } catch (err) {
    console.error("Send transaction error:", err);
    return null;
  }

  try {
    const lastValidBlockHeight =
      swapData.lastValidBlockHeight ?? (await connection.getLatestBlockhash("confirmed")).lastValidBlockHeight;
    const confirmation = await connection.confirmTransaction(
      { signature, blockhash: transaction.message.recentBlockhash, lastValidBlockHeight },
      "confirmed"
    );
    if (confirmation.value.err) {
      console.error(`Transaction ${signature} failed on-chain:`, confirmation.value.err);
      return null;
    }
  } catch (err) {
    console.error(`Could not confirm transaction ${signature}; not recording it:`, err);
    return null;
  }
  return signature;
}

export async function getTokenDecimals(connection: Connection, tokenMintAddress: string): Promise<number> {
  if (tokenMintAddress === SOL_MINT) return 9;
  const info = await connection.getParsedAccountInfo(new PublicKey(tokenMintAddress));
  const decimals = (info?.value?.data as any)?.parsed?.info?.decimals;
  if (typeof decimals !== "number") {
    throw new Error(`Could not read decimals for mint ${tokenMintAddress}`);
  }
  return decimals;
}

async function postTweet(cfg: IConfig, state: ITradingState, content: string) {
  if (!cfg.tweetsEnabled) {
    console.log(`[tweet not sent] ${content}`);
    return;
  }
  if (state.lastTweetContent === content) return;
  try {
    const scraper = new Scraper();
    if (!(await scraper.isLoggedIn())) {
      const username = process.env.TWITTER_USERNAME || "";
      const password = process.env.TWITTER_PASSWORD || "";
      if (!username || !password) throw new Error("Missing TWITTER_USERNAME or TWITTER_PASSWORD.");
      await scraper.login(username, password, process.env.TWITTER_EMAIL || "");
    }
    await scraper.sendTweet(content);
    state.lastTweetContent = content;
    console.log("Tweet posted:", content);
  } catch (err) {
    console.error("Failed to post tweet:", err);
  }
}

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------

function passesFilters(cfg: IConfig, c: ICandidate): boolean {
  return c.liquidityUsd >= cfg.minLiquidityUsd && c.volume24hUsd >= cfg.minVolumeUsd;
}

async function fetchCandidates(cfg: IConfig): Promise<ICandidate[]> {
  return cfg.tokenSource === "birdeye" ? fetchBirdeyeCandidates(cfg) : fetchDexScreenerCandidates(cfg);
}

/**
 * Free, keyless source: Solana tokens from DexScreener's latest profiles and top
 * boosts, enriched with pair data. Liquidity and volume are summed over each
 * token's pairs; pairs younger than TRADING_MIN_PAIR_AGE_HOURS are ignored.
 */
async function fetchDexScreenerCandidates(cfg: IConfig): Promise<ICandidate[]> {
  const base = "https://api.dexscreener.com";
  const getJson = async (url: string) => {
    const r = await fetch(url, { headers: { accept: "application/json" } });
    if (!r.ok) throw new Error(`DexScreener ${url} failed with status ${r.status}`);
    return r.json();
  };

  const lists = await Promise.all([
    getJson(`${base}/token-profiles/latest/v1`),
    getJson(`${base}/token-boosts/top/v1`),
  ]);
  const addresses = [
    ...new Set(
      lists
        .flat()
        .filter((t: any) => t?.chainId === "solana" && t?.tokenAddress && t.tokenAddress !== SOL_MINT)
        .map((t: any) => String(t.tokenAddress))
    ),
  ];

  const minCreatedAt = Date.now() - cfg.minPairAgeHours * 3_600_000;
  const byToken = new Map<string, ICandidate & { bestLiquidity: number }>();
  for (let i = 0; i < addresses.length; i += 30) {
    const pairs: any[] = await getJson(`${base}/tokens/v1/solana/${addresses.slice(i, i + 30).join(",")}`);
    for (const p of pairs || []) {
      const addr = p?.baseToken?.address;
      if (!addr || !addresses.includes(addr)) continue;
      if (!p.pairCreatedAt || p.pairCreatedAt > minCreatedAt) continue;
      const liq = Number(p.liquidity?.usd || 0);
      const vol = Number(p.volume?.h24 || 0);
      const prev = byToken.get(addr);
      if (!prev) {
        byToken.set(addr, {
          symbol: String(p.baseToken.symbol || "?"),
          address: addr,
          liquidityUsd: liq,
          volume24hUsd: vol,
          priceUsd: Number(p.priceUsd || 0),
          rank: null,
          bestLiquidity: liq,
        });
      } else {
        prev.liquidityUsd += liq;
        prev.volume24hUsd += vol;
        if (liq > prev.bestLiquidity) {
          prev.bestLiquidity = liq;
          prev.priceUsd = Number(p.priceUsd || 0);
        }
      }
    }
  }

  const candidates = [...byToken.values()]
    .map(({ bestLiquidity: _b, ...c }) => c)
    .filter((c) => passesFilters(cfg, c))
    .sort((a, b) => b.liquidityUsd - a.liquidityUsd)
    .slice(0, 20);
  console.log(
    `DexScreener: ${addresses.length} Solana tokens, ${byToken.size} with pairs older than ${cfg.minPairAgeHours}h, ` +
      `${candidates.length} passed liquidity/volume filters.`
  );
  return candidates;
}

async function fetchBirdeyeCandidates(cfg: IConfig): Promise<ICandidate[]> {
  // Sorted descending so the most liquid / most traded trending tokens come first.
  const endpoints = [
    "https://public-api.birdeye.so/defi/token_trending?sort_by=rank&sort_type=asc&offset=0&limit=20",
    "https://public-api.birdeye.so/defi/token_trending?sort_by=volume24hUSD&sort_type=desc&offset=0&limit=20",
    "https://public-api.birdeye.so/defi/token_trending?sort_by=liquidity&sort_type=desc&offset=0&limit=20",
  ];
  const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];
  console.log(`Birdeye endpoint: ${endpoint}`);
  const data = await birdeyeGet(cfg, endpoint);

  const tokens: any[] = data?.data?.tokens || [];
  const candidates = tokens
    .filter((t) => t?.address && t?.symbol && t.address !== SOL_MINT)
    .map((t) => ({
      symbol: String(t.symbol),
      address: String(t.address),
      liquidityUsd: Number(t.liquidity || 0),
      volume24hUsd: Number(t.volume24hUSD || 0),
      priceUsd: Number(t.price || 0),
      rank: t.rank ?? null,
    }))
    .filter((c) => passesFilters(cfg, c));

  console.log(`Birdeye: ${candidates.length}/${tokens.length} tokens passed liquidity/volume filters.`);
  return candidates;
}

async function getTradeRecommendations(cfg: IConfig, candidates: ICandidate[], solBalance: number, maxSolPerPosition: number) {
  const prompt = `
You pick at most ${cfg.maxBuysPerCycle} Solana tokens to buy with SOL from the candidate list below, or none.
Prefer deep liquidity, healthy volume relative to liquidity, and avoid anything that looks like a pump.
Wallet balance: ${solBalance.toFixed(4)} SOL. Never allocate more than ${maxSolPerPosition.toFixed(4)} SOL to one token.

Candidates (only these addresses are allowed):
${JSON.stringify(candidates, null, 2)}

Reply with JSON only:
{"recommendations":[{"ticker":"SYMBOL","outputTokenCA":"ADDRESS_FROM_LIST","amountToBuyInSol":0.05,"reason":"one sentence"}]}
Return {"recommendations":[]} if nothing is worth buying.
`;
  const raw = await openAiChat(cfg, prompt, 0, 800, true);
  const cleaned = raw.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed?.recommendations)) {
    throw new Error(`LLM response missing recommendations array: ${raw}`);
  }
  return parsed.recommendations as Array<{ ticker: string; outputTokenCA: string; amountToBuyInSol: number | string; reason?: string }>;
}

// ---------------------------------------------------------------------------
// Buying and selling
// ---------------------------------------------------------------------------

async function getSpendableSol(runtime: IAgentRuntime, cfg: IConfig, connection: Connection, state: ITradingState): Promise<number> {
  if (!cfg.live) return state.paperSol;
  const { publicKey } = await getWalletKey(runtime, false);
  return (await connection.getBalance(publicKey)) / 1e9;
}

async function buyRecommendedTokens(
  runtime: IAgentRuntime,
  cfg: IConfig,
  connection: Connection,
  state: ITradingState,
  candidates: ICandidate[],
  recommendations: Awaited<ReturnType<typeof getTradeRecommendations>>
) {
  const allowed = new Map(candidates.map((c) => [c.address, c]));
  let buys = 0;

  for (const rec of recommendations) {
    if (buys >= cfg.maxBuysPerCycle) break;

    const candidate = allowed.get(rec?.outputTokenCA);
    if (!candidate) {
      console.error(`LLM recommended an address that is not in the candidate list, skipping: ${rec?.outputTokenCA}`);
      continue;
    }
    if (state.positions[candidate.address]?.quantity > 0) {
      console.log(`Already holding ${candidate.symbol}, skipping.`);
      continue;
    }

    const balance = await getSpendableSol(runtime, cfg, connection, state);
    const cap = Math.min(balance * cfg.maxPositionFraction, balance - cfg.solReserve);
    const requested = Number(rec.amountToBuyInSol);
    if (!Number.isFinite(requested) || requested <= 0) {
      console.error(`Invalid SOL amount from LLM: ${rec.amountToBuyInSol}, skipping.`);
      continue;
    }
    const spendSol = Math.min(requested, cap);
    if (spendSol <= 0.001) {
      console.log(`Not enough spendable SOL for ${candidate.symbol} (cap ${cap.toFixed(4)}), stopping buys.`);
      break;
    }
    if (spendSol < requested) {
      console.log(`Capping ${candidate.symbol} buy from ${requested} to ${spendSol.toFixed(4)} SOL.`);
    }

    const lamports = new BigNumber(spendSol).multipliedBy(1e9).integerValue(BigNumber.ROUND_DOWN);
    const quote = await getQuote(cfg, SOL_MINT, candidate.address, lamports);
    if (!quote) continue;
    if (quote.priceImpactPct > 2) {
      console.log(`Price impact ${quote.priceImpactPct.toFixed(2)}% too high for ${candidate.symbol}, skipping.`);
      continue;
    }

    const decimals = await getTokenDecimals(connection, candidate.address);
    const quantity = quote.outAmount.div(new BigNumber(10).pow(decimals)).toNumber();
    const spentSol = quote.inAmount.div(1e9).toNumber();
    if (!(quantity > 0)) {
      console.error(`Quote for ${candidate.symbol} returned zero output, skipping.`);
      continue;
    }

    let txUrl = "(paper trade)";
    if (cfg.live) {
      const signature = await executeSwap(runtime, cfg, connection, quote);
      if (!signature) continue;
      txUrl = `https://solscan.io/tx/${signature}`;
    } else {
      state.paperSol -= spentSol;
    }

    state.positions[candidate.address] = {
      ticker: candidate.symbol,
      tokenCA: candidate.address,
      costBasisSOL: spentSol / quantity,
      quantity,
      decimals,
      partialSales: 0,
      openedAt: new Date().toISOString(),
    };
    saveState(cfg, state);
    buys++;
    console.log(
      `${cfg.live ? "BOUGHT" : "PAPER BUY"} ${quantity} ${candidate.symbol} for ${spentSol.toFixed(4)} SOL. ${rec.reason || ""} ${txUrl}`
    );

    try {
      const tweet = await openAiChat(
        cfg,
        `Write a concise, professional tweet announcing the purchase of ${spentSol.toFixed(3)} SOL of ${candidate.symbol} ` +
          `(CA: ${candidate.address}). Tx: ${txUrl}. Do not invent facts. Add a short stoic rationale, ` +
          `perhaps a quote from Marcus Aurelius or Seneca. No hashtags. Under 280 characters.`,
        0.6,
        200,
        false
      );
      await postTweet(cfg, state, tweet);
    } catch (err) {
      console.error("Error generating buy tweet:", err);
    }
  }
}

async function fetchCurrentPriceInSOL(cfg: IConfig, pos: IPosition): Promise<number> {
  const oneToken = new BigNumber(10).pow(pos.decimals);
  const quote = await getQuote(cfg, pos.tokenCA, SOL_MINT, oneToken);
  return quote ? quote.outAmount.div(1e9).toNumber() : 0;
}

/** Sells `fraction` of the position. Returns true only if the sale happened. */
async function sellFractionOfPosition(
  runtime: IAgentRuntime,
  cfg: IConfig,
  connection: Connection,
  state: ITradingState,
  pos: IPosition,
  fraction: number,
  reason: string
): Promise<boolean> {
  const tokensToSell = fraction >= 1 ? pos.quantity : pos.quantity * fraction;
  if (tokensToSell <= 0) return false;

  const baseUnits = new BigNumber(tokensToSell).multipliedBy(new BigNumber(10).pow(pos.decimals)).integerValue(BigNumber.ROUND_DOWN);
  const quote = await getQuote(cfg, pos.tokenCA, SOL_MINT, baseUnits);
  if (!quote) return false;

  const solReceived = quote.outAmount.div(1e9).toNumber();
  if (cfg.live) {
    const signature = await executeSwap(runtime, cfg, connection, quote);
    if (!signature) return false;
    console.log(`Sell tx: https://solscan.io/tx/${signature}`);
  } else {
    state.paperSol += solReceived;
  }

  const pnl = solReceived - pos.costBasisSOL * tokensToSell;
  pos.quantity = fraction >= 1 ? 0 : pos.quantity - tokensToSell;
  state.realizedPnlSol += pnl;
  if (pos.quantity <= 0) delete state.positions[pos.tokenCA];
  saveState(cfg, state);
  console.log(
    `${cfg.live ? "SOLD" : "PAPER SELL"} ${tokensToSell} ${pos.ticker} for ${solReceived.toFixed(4)} SOL ` +
      `(${reason}, PnL ${pnl >= 0 ? "+" : ""}${pnl.toFixed(4)} SOL)`
  );

  try {
    const tweet = await openAiChat(
      cfg,
      `Write a concise tweet announcing we sold ${tokensToSell.toFixed(2)} ${pos.ticker} for about ${solReceived.toFixed(3)} SOL, ` +
        `a ${pnl >= 0 ? "profit" : "loss"} of about ${Math.abs(pnl).toFixed(3)} SOL. A stoic perspective, no hashtags, under 280 characters.`,
      0.6,
      200,
      false
    );
    await postTweet(cfg, state, tweet);
  } catch (err) {
    console.error("Error generating sell tweet:", err);
  }
  return true;
}

// Take-profit ladder: [price multiple, fraction of remaining position to sell]
const TAKE_PROFIT_LADDER: Array<[number, number]> = [
  [2, 0.5],
  [4, 0.25],
  [8, 0.15],
  [16, 0.1],
];
const STOP_LOSS_RATIO = 0.5;

async function sellTokensIfNeeded(runtime: IAgentRuntime, cfg: IConfig, connection: Connection, state: ITradingState) {
  for (const pos of Object.values(state.positions)) {
    if (pos.quantity <= 0) continue;
    const price = await fetchCurrentPriceInSOL(cfg, pos);
    if (!price) {
      console.log(`No price for ${pos.ticker}, skipping.`);
      continue;
    }
    const ratio = price / pos.costBasisSOL;
    console.log(`${pos.ticker}: ${ratio.toFixed(2)}x cost basis, partial sales ${pos.partialSales}`);

    if (ratio <= STOP_LOSS_RATIO) {
      await sellFractionOfPosition(runtime, cfg, connection, state, pos, 1, "stop-loss");
      continue;
    }
    for (let i = pos.partialSales; i < TAKE_PROFIT_LADDER.length; i++) {
      const [multiple, fraction] = TAKE_PROFIT_LADDER[i];
      if (ratio < multiple) break;
      const sold = await sellFractionOfPosition(runtime, cfg, connection, state, pos, fraction, `take-profit ${multiple}x`);
      if (!sold) break;
      pos.partialSales = i + 1;
      saveState(cfg, state);
    }
  }
}

// ---------------------------------------------------------------------------
// Cycle
// ---------------------------------------------------------------------------

export async function runTradingCycle(runtime: IAgentRuntime, opts: { ignoreCooldown?: boolean } = {}): Promise<boolean> {
  if (cycleRunning) {
    console.log("A trading cycle is already running, skipping.");
    return false;
  }
  cycleRunning = true;
  try {
    const cfg = loadConfig(runtime);
    if (!cfg.openAiApiKey) {
      throw new Error("OPENAI_API_KEY is required.");
    }
    if (cfg.tokenSource === "birdeye" && !cfg.birdeyeApiKey) {
      throw new Error("BIRDEYE_API_KEY is required when TRADING_TOKEN_SOURCE=birdeye.");
    }
    const state = loadState(cfg);
    const sinceLast = Date.now() - state.lastCycleAt;
    if (!opts.ignoreCooldown && sinceLast < cfg.cooldownMs) {
      console.log(`Cooldown: next cycle in ${Math.ceil((cfg.cooldownMs - sinceLast) / 60_000)} min.`);
      return false;
    }
    state.lastCycleAt = Date.now();
    saveState(cfg, state);

    console.log(`=== Trading cycle (${cfg.live ? "LIVE — real funds" : "PAPER — no transactions are sent"}) ===`);
    const connection = new Connection(cfg.rpcUrl, "confirmed");

    // Manage existing positions first so stops are not delayed by new buys.
    await sellTokensIfNeeded(runtime, cfg, connection, state);

    const balance = await getSpendableSol(runtime, cfg, connection, state);
    const maxSolPerPosition = Math.min(balance * cfg.maxPositionFraction, balance - cfg.solReserve);
    console.log(`Spendable balance ${balance.toFixed(4)} SOL, max per position ${Math.max(0, maxSolPerPosition).toFixed(4)} SOL.`);

    if (maxSolPerPosition > 0.001 && cfg.maxBuysPerCycle > 0) {
      const candidates = await fetchCandidates(cfg);
      if (candidates.length > 0) {
        const recs = await getTradeRecommendations(cfg, candidates, balance, maxSolPerPosition);
        console.log("LLM recommendations:", recs);
        await buyRecommendedTokens(runtime, cfg, connection, state, candidates, recs);
      }
    } else {
      console.log("Not enough SOL to open new positions.");
    }

    console.log(
      `Cycle done. Open positions: ${Object.keys(state.positions).length}, realized PnL ${state.realizedPnlSol.toFixed(4)} SOL` +
        (cfg.live ? "" : `, paper balance ${state.paperSol.toFixed(4)} SOL`)
    );
    return true;
  } finally {
    cycleRunning = false;
  }
}

const purchaseRecommendedTokensAction: Action = {
  name: "PURCHASE_RECOMMENDED_TOKENS",
  similes: ["GET_RECOMMENDED_TOKENS", "BUY_RECOMMENDED_TOKENS"],
  description:
    "Runs one trading cycle: manage open positions, pick trending Solana tokens with an LLM and buy them (paper mode unless TRADING_MODE=live).",

  validate: async (_runtime: IAgentRuntime, _message: Memory) => true,

  handler: async (runtime: IAgentRuntime, _message: Memory, _state?: State) => {
    try {
      return await runTradingCycle(runtime);
    } catch (error) {
      console.error("Error in trading cycle:", error);
      return false;
    }
  },

  examples: [
    [
      { user: "{{user1}}", content: { text: "Run a trading cycle and buy any recommended tokens." } },
      {
        user: "{{user2}}",
        content: { text: "Running the trading cycle now.", action: "PURCHASE_RECOMMENDED_TOKENS" },
      },
    ],
  ],
};

export default purchaseRecommendedTokensAction;
