import modelsConfig from "@config/models.json";

import {
  type ChainSummary,
  type LiveChain,
  summariseKeylessChain,
  summariseLiveChain,
} from "./model-chain";

export function loadKeylessChain(): ChainSummary {
  return summariseKeylessChain(modelsConfig);
}

export function loadLiveChain(): LiveChain {
  return summariseLiveChain(modelsConfig, process.env);
}
