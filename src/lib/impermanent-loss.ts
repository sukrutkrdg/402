export async function impermanentLossCalculator(params: Record<string, string>) {
  const initialPriceRatioStr = params.initial_ratio;
  const currentPriceRatioStr = params.current_ratio;

  if (!initialPriceRatioStr || !currentPriceRatioStr) {
    throw new Error("Missing initial_ratio or current_ratio");
  }

  const initialRatio = parseFloat(initialPriceRatioStr);
  const currentRatio = parseFloat(currentPriceRatioStr);

  if (isNaN(initialRatio) || isNaN(currentRatio) || initialRatio <= 0 || currentRatio <= 0) {
    throw new Error("Ratios must be valid positive numbers");
  }

  // price ratio change: k = current_ratio / initial_ratio
  const k = currentRatio / initialRatio;

  // IL formula: 2 * sqrt(k) / (1 + k) - 1
  const impermanentLoss = (2 * Math.sqrt(k)) / (1 + k) - 1;

  // convert to percentage
  const ilPercentage = impermanentLoss * 100;

  let advice = "Negligible impermanent loss.";
  if (Math.abs(ilPercentage) > 5) {
    advice = "Significant impermanent loss detected. Review your LP position.";
  } else if (Math.abs(ilPercentage) > 20) {
    advice = "Severe impermanent loss detected. The pool ratio has shifted drastically.";
  }

  return {
    initial_ratio: initialRatio,
    current_ratio: currentRatio,
    price_change_factor: k.toFixed(4),
    impermanent_loss_pct: ilPercentage.toFixed(2) + "%",
    advice
  };
}
