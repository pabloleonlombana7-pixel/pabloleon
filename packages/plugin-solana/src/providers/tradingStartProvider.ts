import { Provider, IAgentRuntime, Memory, State } from "@elizaos/core";
import { startTradingLoop } from "../actions/mainTradingActions";

// elizaOS calls providers every time it composes state (i.e. on every message),
// so this only starts the loop once and returns immediately.
const tradingStartProvider: Provider = {
    get: async (runtime: IAgentRuntime, _message: Memory, _state?: State) => {
        try {
            startTradingLoop(runtime);
        } catch (error) {
            console.error("Could not start the trading loop:", error);
        }
        return "";
    },
};

export { tradingStartProvider };
