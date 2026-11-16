import { Action, IAgentRuntime, Memory } from "@elizaos/core";
import { runTradingCycle } from "./purchaseRecommendedTokens";

let loopStarted = false;

/**
 * Starts the autonomous trading loop exactly once per process.
 * The first cycle runs right away; after that one cycle runs every
 * TRADING_COOLDOWN_MINUTES (default 60). Cycles never overlap.
 */
export function startTradingLoop(runtime: IAgentRuntime): boolean {
    if (loopStarted) return false;
    loopStarted = true;

    const raw = Number(runtime.getSetting("TRADING_COOLDOWN_MINUTES"));
    const intervalMinutes = Number.isFinite(raw) && raw > 0 ? raw : 60;
    console.log(`Modern Stoic trading loop started, one cycle every ${intervalMinutes} min.`);

    const tick = async () => {
        try {
            await runTradingCycle(runtime);
        } catch (error) {
            console.error("Error in trading cycle:", error);
        }
    };
    void tick();
    setInterval(tick, intervalMinutes * 60_000);
    return true;
}

const mainTradingActions: Action = {
    name: "MAIN_TRADING_ACTIONS",
    similes: ["TRADING_ACTIONS", "MAIN_TRADE_ACTIONS"],
    description: "Starts the autonomous trading loop if it is not already running.",
    validate: async (_runtime: IAgentRuntime, _message: Memory) => true,
    handler: async (runtime: IAgentRuntime, _message: Memory) => {
        startTradingLoop(runtime);
        return true;
    },
    examples: [
        [
            {
                user: "{{user1}}",
                content: { text: "Start the autonomous trading loop" },
            },
            {
                user: "{{user2}}",
                content: { text: "Trading loop started.", action: "MAIN_TRADING_ACTIONS" },
            },
        ],
    ],
};

export default mainTradingActions;
