import { Action, IAgentRuntime, Memory } from "@elizaos/core";
import { startTradingLoop } from "./mainTradingActions";

const tradingStartAction: Action = {
    name: "TRADING_START_ACTION",
    similes: ["TRADING_START"],
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
                content: { text: "Start the trading loop" },
            },
            {
                user: "{{user2}}",
                content: { text: "Starting the trading loop.", action: "TRADING_START_ACTION" },
            },
        ],
    ],
};

export default tradingStartAction;
