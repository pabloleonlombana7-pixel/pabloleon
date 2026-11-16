# stoictradingAI

An autonomous Solana trading agent, built as a plugin on the elizaOS agent framework and developed live in public.

The agent runs a full loop without a human in it:

1. **Ingest** market data from Birdeye and Helius.
2. **Filter** candidates on liquidity, volume, holder distribution and trust score.
3. **Decide** by asking an LLM for a ranked trade decision with its reasoning.
4. **Execute** swaps on-chain through Jupiter.
5. **Publish** every executed trade with its reasoning and transaction link, so anyone can audit what it did.

## Where the work is

Most of this repository is the elizaOS framework (v0.1.7). The trading system lives in `packages/plugin-solana/src/`:

| File | Role |
|---|---|
| `actions/mainTradingActions.ts` | Trading loop entry point |
| `actions/tradingStartAction.ts`, `providers/tradingStartProvider.ts` | Starts and schedules the loop |
| `actions/fetchBirdEyeData.ts` | Market data ingestion and candidate filtering |
| `actions/purchaseRecommendedTokens.ts` | LLM trade selection and position sizing |
| `actions/swap.ts` | Jupiter swap execution and trade publishing |
| `providers/wallet.ts`, `providers/token.ts` | Portfolio and asset state |
| `characters/modern_stoic.character.json` | Agent configuration |

## Running it

```bash
cp .env.example .env   # fill in your own keys; never commit this file
pnpm install
pnpm build
pnpm start --character=characters/modern_stoic.character.json
```

The agent starts in **paper mode**: it reads real market data and real Jupiter quotes, but never signs or sends a transaction and never tweets. Trades are simulated against a virtual balance (`TRADING_PAPER_SOL`, default 1 SOL) and state is saved to `data/stoic-trading-paper.json`. Set `TRADING_MODE=live` only after you have reviewed the code and are prepared to lose the funds in the wallet.

Risk and loop settings (see the top of `purchaseRecommendedTokens.ts`): `TRADING_MAX_POSITION_FRACTION` (0.2), `TRADING_MAX_BUYS_PER_CYCLE` (2), `TRADING_MIN_LIQUIDITY_USD` (50000), `TRADING_MIN_VOLUME_USD` (100000), `TRADING_SLIPPAGE_BPS` (100), `TRADING_SOL_RESERVE` (0.02), `TRADING_COOLDOWN_MINUTES` (60), `SOLANA_RPC_URL`, `JUPITER_API_URL`, `TRADING_OPENAI_MODEL`, `TRADING_TWEETS_ENABLED`.

Required environment variables include `SOLANA_PRIVATE_KEY`, `SOLANA_PUBLIC_KEY`, `OPENAI_API_KEY`, `BIRDEYE_API_KEY`, `HELIUS_API_KEY`, and the `TWITTER_*` credentials if publishing is enabled.

## Status

Archived. Kept as an engineering reference; it is not maintained and should not be run with real funds without review.

## Credits

Built on [elizaOS](https://github.com/elizaOS/eliza), MIT licensed. See `LICENSE`.
