import modelsConfig from "@config/models.json";

import { type ChainSummary, summariseKeylessChain } from "./model-chain";

export function loadKeylessChain(): ChainSummary {
  return summariseKeylessChain(modelsConfig);
}
